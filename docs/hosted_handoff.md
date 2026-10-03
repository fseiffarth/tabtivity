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

## P2 (single-user server, "my box, thin clients")

*Written 2026-10-03 by the P2 agent. Base `b2eae3d1` (P0, P1 part 1 and their
reviews). Nothing run live — AGENTS.md forbids starting the app or the
sidecar against the user's state dir; the live checks are listed below for
the user. Rationale, as built: [`context/web_client.md`](context/web_client.md).*

### Commits

| Commit | Content |
|---|---|
| `5cd3dfe3` | The generated `core` dispatcher: `build.rs` (`syn`) emits one JSON-args wrapper per Tauri-free `#[tauri::command]` into `OUT_DIR/core_dispatch.rs`; `services::core_dispatch` (class check → model allowlist → wrapper; `capabilities`), `services::model_allowlist`, `Settings.ollama_allowed_models`. |
| `1f7d32fb` | `commands/fs.rs` → `Ctx` (15 commands, 2 helpers); `read_file_bytes_for` / `write_file_bytes_for` for other hosts; `save_pending_screenshot` passes `Ctx` on. |
| `a084b436` | `mobile_control::web_client`: `/desktop/*` bundle serving, token login, the socket, `WebEvents` as the sink, resume/grace, binary frames, the user-content origin; `lib.rs::Singletons` + `standalone_core_state`; `MobileHostSettings.browser_client`; `mobile_browser_client_link`; brand names `DESKTOP_SESSION_COOKIE`, `DESKTOP_PROTOCOL`; dev-dep `tokio-tungstenite`. |
| `8b6f9d1e` | `src/main-web.tsx`, `lib/transport/{wsClient,wsInternals,clientAdapters,dialogAdapter,installWeb,linkState,commandClasses}.ts`, `web/WebShell.tsx`, `components/common/ServerFilePicker.tsx`, `commands::fs::list_dir_all`, `vite.web.config.ts`, `npm run web:bundle` (in `npm run build`), `command_class::command_classes_ts` + its currency test, `WebTransport.test.ts`. |
| `bbddfbba` | `lib/platform.ts`: `HOST_OS`/`IS_HOST_*` beside the client flags; the 31-file audit (host-side uses moved). |
| `80a3702f` | Settings → Mobile → Browser access (toggle + sign-in link + copy); Recent Downloads hidden in the browser. |
| `fd348bd0` | `services::pick_grants`; the five mail `*_grant` siblings; `desktop_file_grant`; `lib/mail.ts` takes the grant path in the browser. |
| `b1d126d9` | `switch_project_runtime` split: `services::project_runtime::switch_session` + core command `switch_project_session`; the shim answers the client command with it. |
| `ddfdea27` | `terminalBus` offset catch-up after a reconnect; third-party checklist row for the shim; map rows. |
| the commit after | this section, the plan's P2 bullets, TODO #2341–#2346 (+ a note on #2339), `docs/context/web_client.md`, its AGENTS.md entry. |

### Design (as built; the rationale per decision is in `context/web_client.md`)

- **Dispatcher.** `build.rs` → `OUT_DIR/core_dispatch.rs`: `handler(cmd) -> Option<Handler>`, `NOT_DISPATCHABLE: [(name, reason)]`, `dispatchable_names()`. Wrappers read arguments with `arg(&args, "camelKey", cmd)` and let the call infer the type; sync bodies run on the blocking pool; `Result<T, E>` errors are serialized like Tauri's `InvokeError`. `core_dispatch::refusal(cmd, role)` → `Unknown | Client | Admin | Off{reason} | Unsupported{reason}`, checked **before** arguments; `dispatch` then runs `model_allowlist::check` and the wrapper. `capabilities(role, protocol)` is one row per `command_class` row (`name, class, served, refusal?`) plus `hostOs` and `role`. `KNOWN_GAPS` (in the module's tests) names every `core` row with no wrapper: the two raw-body commands, the five mail dialogs, `pdf_clip_get/set`, `run_script_detached`.
- **Allowlist.** `MODEL_ARG` lists `(command, model argument)`; `check` reads `Settings.ollama_allowed_models`, or asks `/api/tags` when unset ("what the admin pulled is allowed"); `llama3` matches `llama3:latest`. Refusal `{code:"model-not-allowed", model}`. Desktop never calls it.
- **Sidecar as a host.** `host::run` installs `app_core::rt`, the crypto provider, builds `standalone_core_state()` (fresh `Singletons`, the same list `lib.rs` manages for Tauri — `pick_grants` is new in both) under a `CoreCtx::system` whose sink is `WebEvents`; `kill_all` on its PTYs at a clean stop. `HostState.web` carries it; the host router merges `web_client::routes` after `with_state`, so the middleware covers both; `security_headers` gives `/desktop*` the desktop's CSP plus `ws://<host>` and the shell's inline-script hashes (`INLINE_SCRIPT_HASHES`, an internal header `serve_bundle` sets and the middleware strips).
- **Socket.** `web-<n>` per connection, `Caller::Client(id)`, `Role::Admin`. Text frames `call`/`ret`/`sub`/`unsub`/`event`/`emit`/`hello`; binary `[kind][u32 id][payload]` (`KIND_CALL`=1 in, `KIND_RET`=2 out). Per-client bounded event queue (512) — full drops the event (counted, logged at detach); answers on an unbounded channel bounded by `MAX_CALLS_IN_FLIGHT`=256 permits. WS ping every 20 s, two unanswered → close; the session is `touch`ed on each tick. On close the client's PTY set is parked; `?resume=<id>` within 90 s adopts it, else `route_drop_window_views` + the PTYs are taken and torn down. Transport-level commands: `server_capabilities`, `desktop_file_ticket {path, projectId?, download?} → {url}`, `desktop_file_grant {path} → {grant}`, and `read_file_bytes` (binary answer). `write_file_bytes` arrives as a raw call with Tauri's two headers (percent-decoded).
- **Content origin.** `content_routes` on `port+1` (`content_port_for`), `/content/{ticket}`, `CSP: sandbox; default-src 'none'`, nosniff, `attachment` for active types or `download`, `inline` otherwise; bytes through `fs::read_file_bytes_for` (same confinement as the viewer's read). Bind failure is logged, not fatal.
- **Login.** `web_client::login_token(control_dir)` mints/reads `<control_dir>/web-client.token` (0600); `GET /desktop/login?token=` → `WebSessions::login` → cookie `<slug>_desktop_session; HttpOnly; SameSite=Strict; Path=/` → 303 `/desktop/`. Unauthenticated `/desktop/` → a plain server page telling the user where the link is; hashed `assets/*` are served without a session. Sidecar start prints the bundle dir and the token file path (never the token).
- **Bundle.** `bundle_dir`: `<ENV_PREFIX>WEB_DIST` → `dev_build::SOURCE_ROOT/web-dist` → `<control_dir>/web-dist`; none → a "not built" page. `vite.web.config.ts`: the same `index.html`, `transformIndexHtml` (`order: "pre"`) swaps the entry to `/src/main-web.tsx`, `base: /desktop/`, `outDir: web-dist` (16 MB, gitignored, built by `npm run build`).
- **Frontend.** `installWebTransport()` (before any app module): `markServerClient`, `WsClient` on `ws(s)://<host>/api/v1/desktop/ws`, `installWsInternals`, `pausePollersWhileDown` (wraps `window.setInterval`: callbacks skipped while the link is down). `main-web.tsx` awaits `whenReady()`, stores `hostOs` on `window.__APP_HOST_OS__`, mounts `WebShell` (banner + dialog host) into its own root, then `hardenPrototype()` and `import("./bootstrap")`. The shim routes `plugin:event|*` through a local callback table with refcounted `sub`/`unsub`; `plugin:dialog|open/save` → `dialogAdapter` (the `ServerFilePicker`), `|message` → the pressed button's label as plugin-dialog 2.7 expects; `plugin:notification|*` → the Web Notifications API; `plugin:drag|start_drag` → downloads via tickets; `plugin:window|*` / `plugin:webview|*` → `adaptWindowCommand` (one page: `get_all_windows` = `["main"]`, viewport geometry, `set_zoom` → root `zoom`); everything else by `COMMAND_CLASSES` (generated rows; a credential-looking key with a colon would trip the privacy check, hence rows). `clientAdapters.ts` answers a short list of `client` commands in the browser (`copy_text_to_clipboard`, `open_external_url`, `open_file` → ticket tab, `switch_project_runtime` → `switch_project_session`, `list_recent_downloads` → `[]`, the detached/window no-ops); the rest reject `{code:"client", command}`.
- **`HOST_OS`.** `lib/platform.ts`: `CLIENT_OS` = `PLATFORM` (unchanged semantics for every existing import); `HOST_OS` from the window global, else the client's. Moved to the host flags: `paths.ts` (`sepFor`), `installCommand.ts`, `ProjectDialog`/`ProjectPill`/`FileViewerPane`/`SettingsPanel` install shells and commands, `CenterPanel`/`projects.ts`/`agentClearUndo`/`closeRemoteTab` (tmux), `useRemoteSession`/`useRemoteReconnect` (manual login mode), `TerminalSignInToggle`, `MobileSettings` (its own install tab and the Windows note), `LocalModelsPage`, `AgentsPage`/`SettingsSubPanels` (`NODE_INSTALL`), `FileTree` (`shellRunnerFor`). Left with the client: keys/modifiers, window controls, drag platform, window move, fullscreen, the header's `is-mac`, wheel binding, shortcut labels, the Super-key probe, `terminalSelection`'s EOL (a copy to the client's clipboard), the presenter.
- **Mail file commands.** `commands::mail`'s rule 2 (no path parameter; `no_command_takes_a_path`) stands: the browser's picker returns a path, `desktop_file_grant` mints a five-minute single-use grant (`services::pick_grants`, managed by both hosts, minted only by the transport), and `mail_pgp_import_grant`, `mail_contacts_import_grant`, `mail_contacts_export_grant`, `mail_attach_grants`, `mail_attachment_save_grant` redeem it. The five dialog commands are unchanged and stay `core` + undispatchable (hidden via capabilities).

### Done / deferred

Done: every P2 bullet of §10 (struck in the plan with shas). The user's three decisions: Ollama model management is admin-only *and* user requests are allowlisted server-side; Recent Downloads are the client's (hidden in the browser, `list_recent_downloads` answers `[]` locally); CLI installs are admin-only (served to P2's one admin user; refused for `Role::User`, which nothing creates yet). `switch_project_runtime` is split.

Deferred (TODO group Z): **#2341** CSP + §11 security review before anything beyond localhost; **#2342** popout windows in the browser (`?popout=`); **#2343** browser alternatives for Ctrl+T/W/N; **#2344** `pdf_clip_*`, `run_script_detached`, `browser.rs`'s core half; **#2345** per-client terminal routing in the sink (today each chunk is also serialized under `terminal-output:web-n` and dropped unsubscribed); **#2346** a stale-bundle notice. **#2339** (root MCP in the sidecar) was looked at and *not* done: `commands::root_mcp::start` sweeps the review sandboxes first, so a second listener beside a running window would sweep the window's live ones — agents a browser starts get no `tabtivity-*` MCP tools until the listener moves.

### Live checks for the user (localhost only)

Prerequisites: Mobile enabled with a verified Tailscale Serve origin (the sidecar still requires it), the frozen dev build at or after the docs commit, `npm run web:bundle` run in the checkout the dev build was packaged from (or set `TABTIVITY_WEB_DIST` to a built `web-dist/`).

1. Settings → Mobile → **Browser access** on; restart the Mobile host (Apply / Start host). `journalctl --user -u tabtivity-mobile-host -n 20` shows `desktop client: serving <dir> at http://127.0.0.1:<port>/desktop/`.
2. **Show sign-in link** → Copy → paste into a browser on this machine. Expect a redirect to `/desktop/` and the desktop app rendering; the `tabtivity_desktop_session` cookie is set. Opening `http://127.0.0.1:<port>/desktop/` in a private window shows the plain "Sign in" page instead.
3. From another device on the tailnet, `https://<tailnet-host>/desktop/` must be a 404 (and the phone PWA unaffected).
4. In the browser: open a project, open a shell tab, type — output appears; `tmux ls` on the box shows a `tabtivity-<project>--shell-…` session with two clients when the desktop window has the same tab open. Start a Claude tab; the agent runs (no `tabtivity-*` MCP tools yet, #2339).
5. Open the same project in a second browser tab: both show the same tab set; rename a tab in one, the other follows within a patch; each has its own terminal size (*since #2347 — see § #2347 per-client PTYs for the full steps; before it this failed by construction*). Close one tab page: within 90 s `tmux list-clients` drops one client; the session stays.
6. Kill the link (toggle Wi-Fi, or `kill -STOP` the sidecar for 10 s): the banner "Connection to Tabtivity lost — reconnecting…" shows, the pills stop polling (no error toasts), and on return the terminal catches up from where it stopped (type `seq 1 2000` before the pause).
7. Phone: with the laptop lid closed (window gone, sidecar up with "Keep running when closed"), continue the agent from the phone; reopen the browser: both views identical (the H3 check, now with the browser as the second view).
8. Files: in a viewer, the browser's "open outside" opens `http://127.0.0.1:<port+1>/content/…` in a new tab; an HTML file downloads instead of rendering. Mail → attach a file: the server-side picker appears, the attachment stages. Mail → contacts export: the picker's save mode writes where chosen.
9. Latency: Ctrl+Alt+P (dev perf monitor) in the browser; `pty_write` invokes should sit under 50 ms on loopback.
10. Local model: with `ollama_allowed_models` unset, a completion with an installed model works; add `"ollama_allowed_models": ["nope"]` to `settings.json` and the same completion is refused with `model-not-allowed`.

### Gotchas for P3

- `core_dispatch` wrappers call `crate::commands::<module>::<fn>(Ctx(ctx.clone()), …)`; when P3 moves command bodies into the core crate the generator's `crate::commands::` prefix and `Ctx` newtype must follow (`build.rs::wrapper_source`). The generator parses only top-level fns with `#[tauri::command]`; a command behind `#[cfg]` keeps the attribute on its arm.
- `KNOWN_GAPS` in `core_dispatch::tests` must shrink as files convert — the test fails the other way too ("no longer gaps").
- `commandClasses.ts` is regenerated by `UPDATE_COMMAND_CLASSES=1 cargo test … the_generated_command_classes_ts_is_current`; a class table edit without it fails the test. Rows, not object keys (privacy check).
- `WebEvents` keys subscriptions by exact event name; the terminal router's `<event>:<window>` copies for `web-n` are wasted serialization (#2345).
- `web_client::tests::the_socket_signs_in_calls_and_subscribes` needs the rustls provider installed (it does so itself); `reqwest` is `rustls-no-provider`.
- `Role::Admin` is hard-wired in `serve_socket`; the gateway (P3) decides it per account and passes it in.
- The content origin is `port+1`; nothing checks that port is free before the sidecar binds — a collision is a journal line and "open outside" 404s.
- `vite.web.config.ts` duplicates the pdfjs alias of `vite.config.ts` (two lines); a change there goes here too.
- The privacy check flags `password[[:space:]]*[:=]` and tailnet-looking hostnames in staged text — use `desk.example.ts.net` in tests and rows/tuples for generated maps.
- `tests/project_tree_intent.rs` and `no_command_takes_a_path` are the two source-scanning tests this phase bumped into; both are deliberate.

### Gates (worktree, 2026-10-03, at `ddfdea27`, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + desktop, mobile and web bundles; web bundle 17 s) |
| `npm test -- --reporter=dot` | **693 files, 7060 tests, all pass** (was 691 / 7045) |
| `cargo test -q --no-fail-fast` (src-tauri) | 3182 lib (2 ignored) + 168 integration = **3350 passed**, 0 failed |
| `cargo test -q` (src-core) | 97 passed |
| `npm run lint` | 0 errors, **31 warnings — the same pre-existing 18 files**, none of this phase's |
| `cargo clippy --all-targets -- -D warnings` | clean, both crates |
| `cargo check --target x86_64-pc-windows-msvc` (with the two shims of `project_windows_build`) | green; the same 5 pre-existing warnings P1 listed |
| `scripts/brand-check.sh` | green (48 entries) |
| `scripts/privacy-check.sh` | green on every commit (pre-commit hook; three false positives fixed on the way: a tailnet-looking test host, generated object keys ending in a credential word followed by a colon, and a comment naming the pattern) |
| `git diff --check b2eae3d1 HEAD` | clean |
| `npm run mobile:bundle` | not needed — `mobile-web/` untouched (`npm run build` rebuilt it anyway) |

## P2 review

*Reviewer, 2026-10-03, on branch `hosted` over `b2eae3d1..c99f0b2e` (the 11
P2 commits). Nothing run live; no sidecar started against a real state dir or
port (the socket test binds an ephemeral loopback port with a temp control
dir). Security first — this is a new network surface.*

### What was checked

- **Authn/authz of the browser surface** (`web_client.rs`, `host.rs`): every
  `/desktop*` route and the content origin 404 unless `Host` is a loopback
  literal on the exact expected port (`127.0.0.1`/`localhost`/`[::1]`; the
  listeners are IPv4-only, so `[::1]` is dead letter, not a hole); the
  socket additionally requires `Origin` present and byte-equal to
  `http://` + `Host` (so `null`, a missing Origin, another loopback port and
  a different loopback spelling are all refused — this is what stops CSWSH,
  since `SameSite=Strict` does not help between `127.0.0.1:9999` and
  `127.0.0.1:8742`, which are the same site). Tailscale Serve preserves the
  inbound `Host` (tailnet FQDN), so through it the routes do not exist; the
  socket test covers the `desk.example.ts.net` 404. Token compare is
  `subtle::ct_eq` after a length check; ten failures a minute lock the
  login route. Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age`, no
  `Secure` (plain http on loopback, by design, #2341 for https). The phone's
  `__Host-…_session` and this cookie are read by disjoint routes.
- **Dispatcher**: `core_dispatch::refusal` runs before `arg()` touches the
  frame (`a_refused_call_never_reaches_a_body`); `Client`/`Off` refused for
  everyone, `Admin` for `Role::User`; the generated wrappers read camelCase
  keys with Tauri's wording, missing keys deserialize as `null` (so
  `Option` = `None`), extra keys are ignored like Tauri. The model allowlist
  covers every `core` command that forwards a caller-named model to Ollama
  (`complete_text`, `prepare_local_agent`, `prepare_local_launch`,
  `ensure_vibe_ollama_model`; `load/pull/stop/delete_ollama_model` are
  `admin`; `mail_ai_*` and the root MCP take the model from settings, which
  the browser cannot write — `save_settings` is `off`).
- **`mobile_control` invariant**: the phone routes and their store are
  untouched; the browser surface is a different prefix, cookie and auth, as
  plan §4.3 allows (raw ids of the user's own projects, this user only).
- **File access**: `read_file_bytes`/`write_file_bytes`/`/content/{ticket}`
  all go through `fs::read_file_bytes_for`/`write_file_bytes_for` (the IPC
  shapes' confinement; the socket test shows an outside-root write refused).
  Tickets are 32 random bytes, 5 min, 256 at most; content answers carry
  `CSP: sandbox; default-src 'none'`, `nosniff`, `no-store`, and HTML/SVG/
  XML/JS go as `attachment`. Bundle paths reject `..`, empty parts and
  backslashes. `list_dir_all` and `desktop_file_grant` are deliberately
  unconfined (OS-dialog parity for the admin; see P3 notes below).
- **Resource limits**: per-client event queue of 512 (shed + counted),
  answers bounded by 256 in-flight permits, frames capped at 256 MB + 64 KB,
  two unanswered pings close, the session is re-checked every 20 s;
  `host::run` runs `kill_all` on the sidecar's registry at a clean stop.
- **Desktop unchanged when off**: `browser_client` unset → every
  `/desktop*` route is a 404 inside the existing router, and the content
  listener is never bound; `build.rs` codegen adds ~0.1 s (`syn` over
  `src/commands/*.rs`) and the Windows `cargo check` is green.
- Code quality, i18n keys in all five dictionaries, the two UntestedTag
  rows, file-map rows, TODO #2341–#2346.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** (data loss: a live terminal killed) | A parked client's PTY set is keyed by PTY id = tab id, shared by every page. A reloaded page (new client) or a sibling page re-spawns the same ids; 90 s later `reap_if_still_parked` of the old client took them from the registry and tore down the live page's PTYs. | **Fixed** `d3a6ee23`: a successful `pty_spawn` moves the id to the spawning client, out of every parked and other live set (`WebClientState::note_spawned`); state-level test. |
| 2 | **Medium** (promise broken: "a page that lost its link keeps its PTYs") | A page whose link died without a close frame reconnects with `?resume=` before the server noticed; the id was still "connected", so the page got a fresh id and its PTYs stayed with the stale one, reaped later. | **Fixed** `d3a6ee23`: a resume of a live id takes it over (per-connection generation; the stale loop ends when its link is replaced and neither detaches the new link nor parks anything). Socket test: a second connection resuming `web-1` while the first is open gets `web-1`, the first is closed by the server. |
| 3 | Low (docs) | A comment block in `terminalBus.ts` sat after a `return` inside `sliceBeyond`. | **Fixed** `d3a6ee23`. |
| 4 | **Medium** (design gap, plan §3.5 "terminal size is per client") | A PTY id is the tab id: a second page's `pty_spawn` of an open tab goes through `PtyRegistry::insert`, which kills the first page's attach client and replaces it; both pages then share one PTY and `pty_resize` fights. The P2 handoff's live check 5 ("each has its own terminal size") and the plan bullet claiming per-client size were wrong. | **Open — #2347**; plan bullet corrected. Needs per-client PTY ids in router and registry, not a review-size change. |
| 5 | Low (UX) | A session that idled out (or hit `SESSION_MAX`) makes the socket upgrade 401; `WsClient` cannot see the status and retries forever under "reconnecting…". | **Open — #2348**. |
| 6 | Design (P3) | `Role::Admin` is hard-wired for any cookie holder: everything the box owner can do (CLI installs, `mobile_host_apply`, `mobile_browser_client_link` = the token itself, model pulls/deletes, containers, VPN). Acceptable for P2 by the trust argument (loopback + `0600` token = the admin socket's trust), not beyond. | Open by design; P3's gateway must pass the role in. |
| 7 | Design (P3) | The login token is long-lived, never rotated, and travels in a URL (browser history); there is no logout route. | Open by design (same trust as the control dir). For P3: single-use or short-lived login tokens, a logout/rotate command. |
| 8 | Design (P3) | `read_file_bytes`, `desktop_file_ticket` and `desktop_file_grant` are answered by the transport before `core_dispatch::refusal`, and `list_dir_all` is `core` and unconfined. Fine for one admin; a `Role::User` must not get the whole filesystem. | Open: before P3 serves users, route the transport commands through the class check and confine (or reclass) `list_dir_all`/grants. |
| 9 | Low (risk, live) | `CSP: sandbox` on an inline PDF: Chromium disables plugins in sandboxed documents, so "open outside" of a PDF may download or show blank instead of rendering. | Watch in live check 8; if so, serve PDFs without `sandbox` (they are not active content) or always as `attachment`. |
| 10 | Info | Browser pages subscribe to the plain `terminal-output` name, so every page receives every PTY's chunks in the sidecar (filtered by id client-side); the `:web-n` copies are wasted. | Already #2345. |
| 11 | Info | `MAX_INBOUND_FRAME` (256 MB) × 256 permits bounds memory only in theory; one user, loopback. | Note for P3 limits. |

Not found: path traversal in the bundle or content routes; a way to reach
the dispatcher without the cookie; a missing Origin case; a phone-route
change; a non-constant-time compare; a new listener or port with Browser
access off.

### Gates (worktree, 2026-10-03, at `d3a6ee23` + this docs commit, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + desktop, mobile and web bundles) |
| `npm test -- --reporter=dot` | **693 files, 7060 tests, all pass** |
| `cargo test -q --no-fail-fast` (src-tauri) | 3183 lib (2 ignored) + 168 integration = **3351 passed**, 0 failed (+1: the ownership test) |
| `cargo test -q` (src-core) | 97 passed |
| `npm run lint` | 0 errors, 31 warnings — the same pre-existing ones, none new |
| `cargo clippy --all-targets -- -D warnings` | clean, both crates |
| `cargo check --target x86_64-pc-windows-msvc` | green; the same 5 pre-existing warnings |
| `scripts/brand-check.sh` | green (48 entries) |
| `scripts/privacy-check.sh` | green (pre-commit on each commit; range form over `c99f0b2e..HEAD`) |
| `git diff --check b2eae3d1 HEAD` | clean |

## P3 (partial)

*Written 2026-10-03 by the P3 continuation agent (the first P3 agent stopped
at its usage limit after two commits and left the gateway crate half-made;
this agent finished it). Base `df55687c` (P2 + review). Nothing run on a real
server and nothing run as root: every root or multi-uid step is code plus
generated units, `--dry-run` plans and unprivileged tests. Rationale, as
built: [`context/server_gateway.md`](context/server_gateway.md).*

### Commits

| Commit | Content |
|---|---|
| `cf02b197` | (first P3 agent) P2 review items 6–8: the session's role drives hello/capabilities/calls; transport commands pass the class check; a user's `list_dir_all`/tickets/grants confined; single-use HMAC sign-in links, rotate, logout. |
| `3e01a6f7` | (first P3 agent) `services::server` (server mode from the unit's env, gateway headers, `tmux -L <slug>`, CLI root); `host::run_with(config, Listen)`; `tabtivity-serverd` serving the whole sidecar on a `0660` peer-gated unix socket; device-key browser sessions behind the gateway; invites; `PR_SET_DUMPABLE=0`. |
| `53d70ef5` | `src-gateway/` (package `app-gateway`): the gateway (`server.rs`, `proxy.rs`, `db.rs`, `cookie.rs`, `audit.rs`, `policy.rs`, `statics.rs`, `config.rs`), the admin helper (`helper.rs`, `units.rs`, `prereq.rs`, `names.rs`), `wire.rs`; the first agent's uncommitted brand names (`GATEWAY_COOKIE`, `SERVER_ACCOUNT_PREFIX`) and `routed_pairing_code`; CI lint + test of the crate; `brand-check`/`brand-flip`/`backend-stale` follow it. |
| `fa351c32` | Daemon side: compiles `wire.rs`/`policy.rs` by `#[path]`; socket activation (fd 3 adopted, never removed); content tickets `/content/<user>/<ticket>`; Ollama allowlist from the gateway's policy on a server; feature switches (admin policy ∧ `Settings.disabled_features`) → `Refusal::FeatureOff`, phone routes 403, alarms pause; `serverd --write-invite/--revoke-device/--install-cli`; `agent_install` root = `SERVER_CLI_ROOT` when set. |
| `56a64754` | Sign-in relay: on a server only a listener of the daemon's own uid (`/proc/net/tcp{,6}`) gets the code (`callback_not_yours`). |
| `1d9cec4e` | `services::server::secrets`: §6.8 primitives (per-device ECDH wraps, recovery code, `wraps.json`, persistent keyring). |
| `e6592754` | Every daemon refuses CLI install/update/uninstall on a server with the `cli-install` helper command. |
| `3b88c63d` | `ServerSettings` (Settings → Mobile, browser behind a gateway only): own feature switches; admin policy editor (features, sharing, Ollama allowlist) over `/gateway/v1/policy`; i18n ×5, two `UntestedTag` rows, a vitest. |
| `2ba65cd2` | `scripts/server-isolation-test.sh` — the two-user exit test, run as root on the server. |
| the commit after | this section, the plan's P3 bullets, TODO #2349–#2357, `docs/context/server_gateway.md` + its AGENTS.md entry. |

### Design (short; the rest is in the context file)

- **Gateway = router, not trust root.** Pair → routed by `user:` prefix, the
  daemon checks the helper's invite; challenge/session → routed by the device
  id's owner; a `200` session gets the routing cookie
  (`__Host-<slug>_gateway`, HMAC-SHA256, 13 h, re-checked against
  `gateway.json` on every request). Client `x-gateway-*` headers and the
  routing cookie are stripped before forwarding. A daemon's device id that
  already routes elsewhere is refused (409), never remapped. WebSocket
  splices are registered per `(user, device)`; the table is re-read every
  2 s and a revoked device's splices are aborted.
- **Socket activation** replaces "the helper starts daemons": no root path
  from the gateway, no polkit rule. The gateway accepts a daemon end owned by
  the account's uid or root (a socket-activated socket reports root).
- **Units**: `<slug>-gateway.service` (hardened), `<slug>-users.slice`,
  `<slug>-users-<user>.slice` (nested by name; account names have no dash),
  `<slug>-serverd@.socket/.service`, `<slug>-tmux@.service`
  (`tmux -L <slug> -D`, `TMUX_TMPDIR=/run/<slug>/tmux/<user>`), tmpfiles,
  `/etc/<slug>/server.env`. The daemon `JoinsNamespaceOf=` tmux so both share
  one `PrivateTmp`. No `ProtectSystem`/`NoNewPrivileges` on those two (the
  fence).
- **Helper verbs**: `install`, `user-add [--admin] [--memory --tasks
  --cpu-weight]`, `user-remove`, `invite`, `role`, `device-revoke`,
  `cli-install`, `check`; each a printable `Plan`. Hard rules in the module
  doc and `helper/tests.rs`.
- **Policy** (`/var/lib/<slug>-gateway/policy.json`, `0644`): admin feature
  switches + Ollama allowlist; unreadable → fail closed.
- **Secrets**: primitives only; see TODO #2350 for the wiring.

### Done / deferred

Done: the gateway/daemon split (as two processes; the crate split is not
finished), the helper with its rules and the units, invites, per-user device
keys (the daemon's), the audit log, prerequisite checks, the CLI install root
and admin-only installs, the admin's Ollama list and feature switches (UI +
enforcement), the host-channel inventory, the sign-in relay restriction, the
§6.8 primitives, the isolation test script.

Deferred (TODO group Z §Z.3): **#2349** finish the crate split — the daemon
binary links `libgtk-3`, `libgdk-3`, `libxcb*`, `libdbus-1` (checked with
`ldd`, 66 libraries; no WebKit), so a headless server must install them;
**#2350** §6.8 wiring (ECDH key at pairing, unlock exchange, `mail_crypt`
device-released mode, sealed passwords, recovery dialog, locked push);
**#2351** idle stop vs. timers (decision); **#2352** Web Push delivery into
the gateway; **#2353** security review of gateway + helper, per-device rate
limits; **#2354** "ask your admin" in Manage CLIs; **#2355** loopback
residuals (VM egress proxy); **#2356** account admin from the browser (needs
a polkit path); **#2357** the live run. Not touched, as instructed: #2339
(root MCP in the sidecar), #2347 (per-client PTY ids — multi-user does not
strictly need it: each user has their own daemon and PTYs; it stays a
two-pages-of-one-user issue).

### Live steps for a real server (Ubuntu 24.04, two test accounts)

Run from a checkout of branch `hosted` at or after the docs commit.

1. Build: `npm ci && npm run build` (web-dist, mobile-dist);
   `cargo build --release -p tabtivity --bin tabtivity-serverd`;
   `cargo build --release -p app-gateway`. Install:
   `sudo install -D -m 0755 target/release/tabtivity-serverd target/release/tabtivity-gateway target/release/tabtivity-admin-helper -t /usr/lib/tabtivity/`;
   `sudo mkdir -p /usr/share/tabtivity && sudo cp -r web-dist mobile-dist /usr/share/tabtivity/`.
   Packages: `tmux` (≥ 3.2), `bubblewrap`, `curl`, `libgtk-3-0` (#2349).
2. Prerequisites: `/proc` with `hidepid=invisible` (fstab
   `proc /proc proc defaults,hidepid=invisible 0 0`, then
   `sudo mount -o remount,hidepid=invisible /proc` — on a machine with a
   desktop session add a `gid=` exception group for polkit/logind);
   `sudo sysctl kernel.yama.ptrace_scope=1`; on Ubuntu 24.04 either load the
   `bwrap-userns-restrict` AppArmor profile or set
   `kernel.apparmor_restrict_unprivileged_userns=0`.
3. `sudo /usr/lib/tabtivity/tabtivity-admin-helper --dry-run install --origin https://HOST.TAILNET.ts.net --content-origin https://HOST.TAILNET.ts.net:8443`,
   read the plan, then run it without `--dry-run`. Expect the `tabtivity-gw`
   and `tabtivity-cli` accounts, the `tabtivity-users` group, the units, and
   `systemctl status tabtivity-gateway` active.
4. Tailscale Serve: `sudo tailscale serve --bg --https=443 http://127.0.0.1:8740`
   and `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8741`.
5. `sudo /usr/lib/tabtivity/tabtivity-admin-helper check` → every line `ok`
   (socket_dir may `warn` until the first boot after install).
6. `sudo …/tabtivity-admin-helper user-add alice --admin` and
   `… user-add bob` → each prints `name:12345678`. A refusal check:
   `… user-add <a sudoer>` must fail naming the group.
7. CLIs: `sudo …/tabtivity-admin-helper cli-install claude` (and `codex`);
   `ls -l /opt/tabtivity/agents` owned by `tabtivity-cli`.
8. Alice's phone: open `https://HOST.TAILNET.ts.net/`, pair with
   `alice:…`; `sudo …/tabtivity-admin-helper invite alice` for a second code;
   pair a laptop browser at `/`, then open `/desktop/` — the desktop UI.
   Same for Bob. `systemctl status tabtivity-serverd@alice` is active only
   after Alice's first request (socket activation).
9. Each user: open an agent tab, sign in through a sign-in tab from the phone
   (QA 31bk flow); the agent runs on that user's own login.
10. `sudo systemctl restart` of Alice's daemon unit (`tabtivity-serverd@` + `alice`) while Alice's
    agent runs: the agent keeps running (`tmux -L tabtivity` in
    `tabtivity-tmux@alice`), the browser reconnects.
11. Alice → Settings → Mobile → Server: switch Mail off in the policy; Bob's
    mail view refuses (`feature-off`), Bob's phone mail tab says the feature is
    off; set the allowed models to one model; Bob's completion with another
    model is refused `model-not-allowed`. Bob switches his own Calendar off;
    Alice's stays on.
12. `sudo …/tabtivity-admin-helper device-revoke bob <device id>` (ids in
    `/var/lib/tabtivity-gateway/gateway.json`): Bob's open browser tab loses
    its socket within ~2 s and its next request is unauthenticated.
13. `sudo scripts/server-isolation-test.sh alice bob` → `N passed, 0 failed`.
14. `sudo cat /var/lib/tabtivity-gateway/audit.jsonl`: pair/login/logout/
    admin rows, no IPs, no content.
15. In a fenced agent tab: `keyctl show @u` / `keyctl get_persistent @u` fail
    (EPERM).

### Gotchas for P3b / P4

- `src-gateway/src/wire.rs` and `policy.rs` are compiled into the daemon by
  `#[path]` — std/serde only, no `crate::` paths; `backend-stale.sh` watches
  them.
- The gateway table has two writers (gateway: devices; helper: accounts),
  each under `flock(gateway.lock)` with atomic writes; the helper hands the
  files back to `<slug>-gw` after writing as root. One uid ↔ one account;
  one device id ↔ one account.
- Sockets are by **user name** (`/run/<slug>/users/<user>.sock`); the first
  P3 agent's uid naming is gone.
- New services (P3b's auth-keeper, P4's hub and calendar) go into
  `units.rs`/`names.rs`, new root verbs into `helper.rs` with the same rules
  (ids from the table, no paths, no chown of a user tree, a `Plan` per verb).
  `policy.features.calendar_sharing` already exists for P4c.
- The gateway answers only its public `Host` (and the content host on the
  content listener); tests must send one.
- Privacy-check false positives met here: `<unit>@<name>.socket` reads as an
  e-mail address; a type name ending in the word secret followed by `::` matches the `secret[:=]` pattern (alias the import).
- From this fenced tab, `keyctl(KEYCTL_GET_PERSISTENT)` is EPERM — the
  keyring test records and passes; on a real server run it unfenced.

### Gates (worktree, 2026-10-03, at `2ba65cd2` + the docs commit, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + desktop, mobile and web bundles) |
| `npm test -- --reporter=dot` | **694 files, 7063 tests, all pass** (was 693 / 7060; +`ServerSettings.test.tsx`) |
| `cargo test -q --workspace --no-fail-fast` | src-tauri **3203 lib (2 ignored) + 168 integration = 3371 passed**; src-core **97**; src-gateway **48**; 0 failed |
| `npm run lint` | 0 errors, **31 warnings** — the same pre-existing ones, none new |
| `cargo clippy --all-targets -- -D warnings` | clean for src-tauri, src-core, src-gateway |
| `cargo check --workspace --target x86_64-pc-windows-msvc` (the two shims) | green; the same 5 pre-existing warnings (`home_io.rs`, `agent_auth.rs`, `copilot/process.rs`, `headless.rs`) |
| `scripts/brand-check.sh` | green (49 entries: `src-gateway/Cargo.toml` added — the server binaries are named after the app) |
| `scripts/privacy-check.sh 3e01a6f7..HEAD` | green (and in the pre-commit hook on every commit; two false positives fixed on the way, see Gotchas) |
| `git diff --check df55687c HEAD` | clean |
| `ldd target/debug/tabtivity-serverd` | links GTK/xcb/dbus (#2349), no WebKit |

## P3 review

*Written 2026-10-03 by the P3 reviewer, on `hosted` over `df55687c..d5b08338`
(the ten P3 commits). Read as an attacker who is a legitimate user of the
same server. Nothing was run as root, on a real server, or against the
user's state: the helper and the isolation script were read and exercised
through their unprivileged seams (fake `Accounts`/`Exec`/`Probe`, a shimmed
`runuser`), the gateway and the daemon on temp sockets.*

### What was checked

- **Gateway.** Routing cookie (HMAC, expiry, names/ids charset-bound, re-checked
  against `gateway.json` on every request); `user:code` pairing (unknown
  account answers like a wrong code; the daemon checks the invite; a daemon's
  device id that routes elsewhere is 409, never remapped); challenge/session
  routed by device owner, cookie minted only on the daemon's `200`;
  `x-gateway-*` and the routing cookie stripped on every forwarded request,
  upgrades included (one `prepare` for all); `/content/<user>/<ticket>` (the
  ticket is the daemon's bearer secret, cookies stripped, charset-checked,
  only `/content/<ticket>` reaches the daemon); Host/Origin checks; statics
  path resolution; revocation closing splices; audit rows (no IPs, no
  content, no device names); missing socket → fast 502; smuggling (hyper on
  both sides re-frames; any path reaches only the cookie's own account).
- **Daemon.** Peer gate on every accept, the activation socket included
  (same listener); headers trusted only through it; role from the header
  (fails closed to `user`); policy and `disabled_features` only narrow;
  `feature-off` in `core_dispatch`, the phone's mail/calendar/todo routes and
  alarms; the sign-in relay's `/proc/net/tcp{,6}` uid filter (`SO_REUSEPORT`
  needs the same euid, so another user cannot share the port; the remaining
  window is a listener closing between read and connect).
- **Helper.** Names only (ASCII `^[a-z][a-z0-9_]{0,31}$`, no leading `-`,
  no lookalikes), re-checks at execution, `O_NOFOLLOW|O_DIRECTORY` home
  chmod, `runuser … env -i`, secrets on stdin, `--dry-run` returns before any
  write, CLI installs as `<slug>-cli`.
- **Units.** The server units are *system* units: PID 1 builds their mount
  namespace with real privileges and no user namespace, so the user-manager
  failure of `20f53490` (AppArmor's `unprivileged_userns` confining the
  unit) does not apply and `PrivateTmp=yes` stays; bwrap still needs the
  profile or the sysctl (live step 2), which `check` now really tests.
  Daemon and tmux share one `/tmp` (`JoinsNamespaceOf=`); the socket is
  `root:<slug>-gw 0660` under `0750 root:<slug>-gw`.
- **Secrets primitives.** Fresh ephemeral ECDH key and random 96-bit nonce
  per seal (no reuse), HKDF with domain separation, device id as AAD,
  128-bit recovery code, `wraps.json` `0600`, K zeroized on drop.
- **Desktop unchanged.** Server mode only from `<PREFIX>SERVER_MODE=1`; the
  Windows check is green; the browser Server panel shows the admin half
  only for `role: admin`; i18n ×5, two `UntestedTag` rows, file maps.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **medium** (role escalation) | Behind the gateway the daemon still served `/desktop/login` and honoured token sessions, which are `Admin`. The token file is in the account's own state dir, so any `user` could sign a link with it (through their own routing cookie) and get an admin session in their daemon — past the gateway's role. | fixed `a075bc24`: the login route is a 404 behind the gateway and only the device session authenticates; the daemon test signs a link with the real token file |
| 2 | **medium** (cross-user DoS) | The gateway served both listeners on a bare `TcpListener`: no cap, no header/body/idle deadline — the hole `limits.rs` closed for the P2 sidecar (whose unix listener even says "the deadlines are the gateway's"). Any tailnet peer, or any local user (loopback), could hold descriptors until every account was offline. | fixed `ca2a58ff`: the gateway compiles `limits.rs` by `#[path]` and serves through `GuardedListener` (2048 / 256); the unit gets `LimitNOFILE=8192` |
| 3 | **medium** (gateway account → root) | The helper, as root in the gateway-owned state dir, opened `gateway.lock` `O_CREAT` without `O_NOFOLLOW` (a planted symlink makes root create any empty file, e.g. `/etc/nologin`), read the table and audit log through symlinks (a FIFO hangs it), and fchowned whatever file sat at the name, hard links included. | fixed `a9951b12`: `read_regular` (`O_NOFOLLOW\|O_NONBLOCK`, regular files only), no-follow lock and audit append, chown only a single-link plain file; tests plant the links |
| 4 | **medium** (all users' CLIs) | `runuser` inherited the admin's cwd; the CLI account's installer starts there and `npm` reads `./.npmrc` (registry, scripts) — an admin running `cli-install` from a user-controlled directory would install that user's choice for everyone. | fixed `e417b8cf`: per-account commands start in the account's home (the install root for `<slug>-cli`), tested |
| 5 | **medium** (false assurance) | `check` run with `sudo` (live step 5, the isolation test) probed bwrap as root, which may always open a user namespace: it said `ok` where every user's fence fails closed. | fixed `2e22621e`: as root the probe runs via `runuser -u nobody` |
| 6 | low | A browser socket's role is fixed at its upgrade; the gateway's sweep checked only routing, so a demoted admin kept `admin` on open sockets. | fixed `e803e1c2`: a role change closes the account's live sockets (test) |
| 7 | low | `/gateway/v1/status` connected to every account's socket: under socket activation that starts each user's daemon and tmux, and it always read "up". | fixed `e803e1c2`: reports `socket: present\|missing` from the path, no connect (no UI consumer) |
| 8 | low | The activation fd 3 arrives without `FD_CLOEXEC` and was adopted as is: every `std::process` child of the daemon inherited the listener. | fixed `eef3e600` (+ test); the bind path's comment no longer claims a setgid dir |
| 9 | low | `server_policy()` returned `None` in server mode when the policy env var was missing → the user's own allowlist and every feature on. | fixed `b31e2bd2`: fails closed (test) |
| 10 | low (test validity) | `server-isolation-test.sh` passed on silence: "no such file" counted as a denial under the 0700 home, a missing socket passed both socket checks, root's probe passed on any non-`ok` answer, the tmux check aimed at the *client's* uid path, and arguments were not validated. | fixed `16f29c6e`: `expect_eacces` for paths under the home, socket existence asserted, root must see the connection dropped unanswered, `tmux -S` at B's own socket, both units' private `/tmp`, names validated |
| 11 | **medium, open** (decision) | The "never root-capable" rule checks group names only (`sudo`, `wheel`, `admin`, `root`): a per-user `sudoers` entry passes, and so do root-equivalent groups — `docker` (the plan itself: "the Docker socket is root on the host"), `lxd`/`incus-admin`, `libvirt`, `disk`. A linked member of one can read every other user's home. | open: adding the groups and a `sudo -l -U` probe is small, but it also bars the admin-role account from Docker/VMs on the server — the user's call |
| 12 | medium, open (deferred #2353) | Pair (20/min) and challenge/session (240/min) windows are server-wide and counted before the device lookup, so any tailnet peer without an account can keep every user from pairing or signing in. Behind Tailscale Serve every peer is `127.0.0.1`, so per-peer limits need per-device/per-account windows. | open: #2353 |
| 13 | low, open | Account existence leaks: a pair to a known account whose daemon is down answers 502 (vs 400), timing differs, and an unauthenticated pair attempt wakes that user's daemon by socket activation. | open: judgment (tailnet-only surface; fold into #2353) |
| 14 | low, open | `AuthStore::pair` ignores `invite.json` while an in-memory pairing code is pending in that daemon (a helper invite is refused until it expires). | open: functional, not a boundary |
| 15 | info | CLI installs as `<slug>-cli` use the shared `/tmp`; vendor scripts use `mktemp`, but a private `TMPDIR` under the install root would settle it. `secrets.rs`: `MasterKey::from_bytes(*buf)` leaves a stack copy; the recovery-code string is not zeroized. | open: for #2350 |

Nothing else needed a change: the cookie, header hygiene, device-id
refuse-not-remap, content routing, the peer gate, the role's fail-closed
parse, the relay's uid filter and the helper's name rules held against
every attempt above.

### Gates (worktree, 2026-10-03, at `84253931`, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + desktop, mobile and web bundles) |
| `npm test -- --reporter=dot` | **694 files, 7063 tests, all pass** (unchanged: no frontend change) |
| `cargo test -q --workspace --no-fail-fast` | src-tauri **3205 lib (2 ignored) + 168 integration = 3373**; src-core **97**; src-gateway **63** (48 + 6 new + `limits.rs`'s 9 compiled in); 0 failed. One run hit `sysstat::tests::descendant_pids_serves_cache_hit_for_unchanged_generation` (pre-existing, untouched): passed alone and on the full rerun |
| `npm run lint` | 0 errors, **31 warnings** — the same pre-existing ones |
| `cargo clippy --workspace --all-targets -- -D warnings` (rustc 1.97.1) | clean |
| `cargo check --workspace --target x86_64-pc-windows-msvc` (the two shims) | green; the same 5 pre-existing warnings |
| `scripts/brand-check.sh` | green (49 entries) |
| `scripts/privacy-check.sh d5b08338..HEAD` | green |
| `git diff --check df55687c HEAD` | clean |
| `npm run backend:stale` | the open window predates the build — expected: branch `hosted` is not what the window runs |

## P3 part 2

*Written 2026-10-03 by the P3 part-2 agent. Base `418d6f61` (P3 part 1 + its
review). Nothing run on a real server, nothing run as root, no daemon or
gateway started against a real state dir or port: root steps are plans,
`--dry-run` text and fake-machine tests; the daemon ran only inside tests on
temp sockets. The fence of this tab blocks `keyctl` (EPERM, expected), so the
keyring is exercised through the `KeyHold` abstraction. Rationale, as built:
[`context/server_gateway.md`](context/server_gateway.md).*

### Commits

| Commit | Content |
|---|---|
| `2e2e70b5` | #2353 / review findings 12+13: `src-gateway/src/rate.rs` — strangers (unknown account, account with no pending invite and no recent use, unknown device id) counted per source + one shared window; known devices per device, per account, own ceiling; source = rightmost `X-Forwarded-For` behind loopback (`PeerAddr` connect info). `gateway.json` `invite_until` (written by the helper's `invite`); a pair reaches a daemon only while an invite is pending or the account was routed in the last 15 min — never wakes an idle daemon, answers like an unknown account otherwise. |
| `c23b3a57` | #2350 daemon half: `services::server::vault` (`KeyHold`: `KernelKeyring`/`MemoryHold`; set-up + recovery code; ECDH enrolment checked against the pairing key; identity key; signed unlock exchange; wraps follow devices; `subkey`; sealed credential store; `on_unlock`); `/api/v1/secrets{,/enrol,/unlock,/unlock/finish,/setup,/recover}`; `mail_crypt::UnlockMode::Device` + `enable_default`; mail never opens plaintext on a server and reopens on release; `remote_credentials` → vault on a server; `serverd` installs the vault in `main`; finding 15 (no stack copies of K, zeroizing recovery code, private `TMPDIR` for CLI installs). `tests/server_secrets.rs` (own binary: installs the global vault). |
| `8f41c8b8` | Review finding 11 (user decision): `src-gateway/src/sudoers.rs` + helper refuses any account a sudoers rule names (read-only parse of sudoers + includes; fail closed; nsswitch non-`files` refuses) and members of docker/lxd/incus-admin/libvirt/disk — admin role too, re-checked at execution. Closes #2351 (idle daemons keep running). **Not brand-check green** (a test literal); fixed in `00b2bc4a`. |
| `fbf124c9` | #2350 device half: `mobile-web/src/secrets.ts` (enrol + release after each sign-in), `ServerSecrets.tsx` in Server settings (set-up shows the code once, new code, unlock with code), `recovery-code` rotation route, device-mode label in the mail encryption dialog; i18n ×5; UntestedTag `server.secrets`. |
| `3c090785` | #2349: the crate split, as a feature split (see Design). `src-serverd/` (`app-serverd`, bin `<slug>-serverd`); `src-tauri/src/bin/serverd.rs` removed; CI lint of the no-desktop library + `ldd` step; brand tools follow. |
| `00b2bc4a` | brand-check fix for `8f41c8b8`. |
| `a1802cd8` | Server on someone's desktop (user decision): `<slug>-proc` exception group, polkit drop-in, printed fstab line; `check` fails hidepid on a machine with a display manager without them, and `proc_group` when a server user is a member; daemon's own state dir and app home (`daemon::server_dirs`); isolation script follows. |
| `44a1db52` | #2354: `cliInstalls` in the hello; Manage CLIs shows versions + `sudo <slug>-admin-helper cli-install <id>` instead of buttons; UntestedTag `agents.askAdmin`. **Not npm-test green** (BrandMirror knew no `serverAdminHelper`); fixed in `285fd61b`. |
| `45d1920d` | #2355: VM egress proxy requires per-VM `Proxy-Authorization` (`<vm dir>/proxy.token`, baked into the guest's proxy URL); `407` + blocked-log otherwise. |
| `285fd61b` | BrandMirror fix for `44a1db52`. |
| the commit after | this section, plan P3/§3.6/§8/§8.1, TODO rows, file maps, context file. |

### Design (short)

- **Rate limits.** The rule is "a request naming nobody known never spends a
  known user's budget". Known-device sign-ins are never limited by source,
  because a local account can forge `X-Forwarded-For` to 127.0.0.1:8740.
  Residual: a stranger who knows an account name can still exhaust that
  account's pair window or burn its invite (five misses — the daemon's rule).
- **Secrets wiring.** K lives only in the kernel persistent keyring (read
  through `KeyHold` on every use, never cached), so a daemon restart keeps
  mail and saved passwords open and a reboot locks them. The ECDH key is
  **enrolled after sign-in** (signed by the pairing key), not made at pairing
  as §6.8 says — same trust (TOFU of the identity key over the gateway), but
  it also covers devices paired before this. The identity key
  (`<state>/secrets/identity.key`) is unsealed by necessity. The unlock
  exchange is the PWA's: after a reboot every session is gone, so the
  browser client at `/desktop/` sends the user through `/` anyway.
- **Crate split as a feature split (deviation from §3.2).** Moving the
  command bodies into `app-core` would have meant the whole 126-reference
  services→commands closure; instead the library got a default `desktop`
  feature holding Tauri, its plugins, WebKitGTK/GTK, xcb, arboard, keyring
  and dbus-secret-service. Command attributes are
  `#[cfg_attr(feature = "desktop", tauri::command)]` (sed over 688 sites; the
  generator in `build.rs` reads both forms and the cfg of a gated module);
  the window/OS-only modules (clipboard, ide, pdf_clip, presenter,
  print_native, printing, screenshot, subwindow) and every command whose
  signature names a Tauri type are compiled out without it; `lib.rs`'s
  window host (`run`, crash reporter hooks, menus, scrollbar theme) too;
  `platform::x11` and the X11 bits of `apps.rs` fall back to the
  non-Linux stubs; credentials fall back to the vault only. Commands lost
  from the daemon were all `client` or already undispatchable (Tauri-typed),
  except `dev_build_relaunch` (admin, window-only). The daemon is
  `src-serverd/` with `app-lib = { package = "<slug>", default-features =
  false }`; built alone Cargo resolves no desktop feature.
- **Side by side.** The daemon's state dir is `~/.local/share/<slug>-server`
  and app home `~/<slug>-server` unless the environment names others; this
  also changes plan §3.6's layout for every server. Tailscale Serve is the
  only shared resource (desktop Mobile → `--https=10000`).
- **/proc on a desktop.** Only polkit gets the exception group (drop-in, not
  `/etc/group`); the fstab line is printed, never written.
- **VM proxy.** Token, not a unix socket: slirp's `guestfwd` chardev
  semantics for unix sockets could not be verified here, and every client of
  the guest (curl, git, apt, Node/undici, reqwest) sends credentials from the
  proxy URL. An existing VM is re-provisioned once at its next boot (the
  user-data changes → new instance id → cloud-init re-applies; the
  `/etc/environment` line is appended again).

### Done / remaining

Done: #2349, #2350 (except the push), #2353's rate limits and finding 13,
finding 11, finding 15, #2354, #2355's VM proxy, the server-on-a-desktop
work, #2351 closed as decided. Remaining: the "mail locked since reboot" Web
Push (#2350; depends on #2352 Web Push in the gateway); #2353's helper
review and a gateway body cap; finding 14 (helper invite vs pending in-memory
code); the daemon's `--no-default-features` library is linted but its tests
run only in the desktop configuration; `dev_build_relaunch` is not on a
server. Not touched as instructed: #2356, #2339, #2347, the idle stop.

### New live steps for a real server (in addition to § P3's)

1. Build the daemon **alone**: `cargo build --release -p app-serverd`
   (replaces `-p tabtivity --bin tabtivity-serverd`); `ldd
   target/release/tabtivity-serverd` must name no gtk/gdk/webkit/xcb/dbus.
   `libgtk-3-0` is no longer a server package. Install it with the gateway
   binaries as in § P3 step 1.
2. On a machine with a desktop session: `sudo …/tabtivity-admin-helper
   --dry-run install …` lists `groupadd --system tabtivity-proc`, the
   `polkit.service.d/tabtivity-proc.conf` drop-in and the printed fstab line;
   after the real install put that line in `/etc/fstab`, `sudo mount -o
   remount /proc`, then `… check`: `hidepid` ok; log out and in to the
   desktop and run something that needs polkit (e.g. `pkexec true`, a
   network change in Settings) — it must still ask/work. Without the drop-in
   `check` must say `hidepid` FAIL.
3. Root-equivalent refusal: `sudo usermod -aG docker bob` → `… user-add bob`
   fails naming docker; a file `/etc/sudoers.d/bob` with `bob ALL=(root)
   NOPASSWD: /usr/bin/true` → fails naming the rule; remove both again.
4. Secrets: Alice signs in on her phone at `/` (the PWA enrols her device),
   then in the browser Settings → Mobile → Server → Secrets key: **Set up**,
   write down the code. Mail → set up an account (opt into saving the
   password). `sudo systemctl restart tabtivity-serverd@alice`: mail and the
   saved password still open. Reboot the server: mail shows the locked note;
   open the PWA on the phone → mail opens without typing anything. Unlock
   with the recovery code from a fresh browser after revoking every device.
   As Alice in a fenced agent tab: `keyctl show @u` fails (EPERM).
5. Backup check: `sudo cp -a ~alice/.local/share/tabtivity-server /tmp/x`,
   then nothing in it opens the mail store (key.json mode `device`).
6. Side by side: as a user who also runs the desktop app on the server
   machine, open both; `ls ~/.local/share/` shows `tabtivity` and
   `tabtivity-server`; a project created in one is absent from the other's
   list; the desktop's Mobile host on `--https=10000` and the gateway on 443
   both answer.
7. Manage CLIs in the browser as Bob: no Install/Update/Remove buttons,
   the `sudo tabtivity-admin-helper cli-install <id>` line instead.
8. A VM project with Proxy egress (admin): boots, the agent reaches its API;
   from another account `curl -x http://127.0.0.1:<proxy port>
   https://api.anthropic.com` gets `407` and the pill lists "(no VM
   credentials)".
9. Rate limits: from a second tailnet device, loop 700 challenge POSTs with
   made-up device ids; Alice's phone still signs in.

### Gotchas for the reviewer and P3b/P4

- **Build the daemon alone.** `cargo build --workspace` (and `cargo test
  --workspace`) unify features, so the workspace's `tabtivity-serverd` links
  GTK; only `-p app-serverd` on its own is the real daemon. CI's `ldd` step
  does that.
- **New command attribute.** Write `#[cfg_attr(feature = "desktop",
  tauri::command)]`; a command whose signature needs Tauri also gets
  `#[cfg(feature = "desktop")]`. A new window/OS-only module goes under
  `#[cfg(feature = "desktop")]` in `commands/mod.rs` (the generator copies
  that cfg). `cargo clippy -p tabtivity --no-default-features --lib` catches
  a slip.
- **The vault is global and installed only by `serverd`'s `main`.** Tests
  that need it go in their own integration binary (`tests/server_secrets.rs`
  pattern); never call `vault::install` from a lib test.
- `mail_crypt::enable_default` is now the silent-enable path (device mode on
  a server, keychain elsewhere); new callers should use it.
- The daemon's state dir moved (`<slug>-server`); P3 part 1's live steps
  that name `~/.local/share/tabtivity` mean the `-server` one now.
- Privacy-check false positives met: documentation IPs (use RFC 5737 /
  `2001:db8::`), a proxy URL with credentials in a comment.
- P3b's auth-keeper and P4's hub join `units.rs`/`names.rs`; a system
  service that must see all processes goes into `PROC_EXCEPTION_UNITS`.

### Gates (worktree, 2026-10-03, at `285fd61b` + this docs commit, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + desktop, mobile, web bundles) |
| `npm test -- --reporter=dot` | **697 files, 7071 tests, all pass** (was 694 / 7063) |
| `cargo test -q --workspace --no-fail-fast` | src-tauri **3213 lib (2 ignored) + 169 integration** (+1: `server_secrets`); src-core **99**; src-gateway **78**; **3559 passed, 0 failed**, 22 test binaries |
| `npm run lint` | 0 errors, **31 warnings** — the same pre-existing ones |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings` / `-p app-serverd` | clean (new CI steps) |
| `cargo check --workspace --target x86_64-pc-windows-msvc` (the two shims) | green; the same 5 pre-existing warnings |
| `scripts/brand-check.sh` | green (50 entries: `src-serverd/Cargo.toml` added) |
| `scripts/privacy-check.sh 418d6f61..HEAD` | green (10 commits, 4445 added lines); pre-commit hook on every commit |
| `git diff --check 418d6f61 HEAD` | clean |
| `ldd target/debug/tabtivity-serverd` (built with `cargo build -p app-serverd` alone) | `linux-vdso.so.1`, `libgcc_s.so.1`, `libm.so.6`, `libc.so.6`, `/lib64/ld-linux-x86-64.so.2` — nothing else |

## P3 part 2 review

*Written 2026-10-03 by the P3 part-2 reviewer. Range `418d6f61..bd805ee5`
(12 commits), worktree `hosted`. Nothing run live, nothing as root, no
daemon/gateway against a real state dir or port; the helper and the
isolation script were not run. `keyctl` is EPERM in this fence (expected).*

### What was checked

- **Vault / crypto:** `secrets.rs` + `vault.rs` + routes in
  `mobile_control/host.rs`/`auth.rs`, `mobile-web/src/secrets.ts`. P-256
  ECDH, HKDF-SHA256, AES-256-GCM with random 96-bit nonces (one use per key
  for the transport key; the per-device KEK is fresh per wrap; the
  credential store reseals with a fresh nonce under one subkey — fine at
  this write rate). Signed start binds context, origin, device id, exchange
  id, X and E; the device checks payload text and signature against the
  identity pinned at enrolment; exchange single-use, 60 s, bound to the
  device id; AAD binds device id + exchange id; replay of an answer to a
  new exchange fails (new E). Revoke deletes the wrap and sessions; a
  revoked device gets `no-wrap`. Daemons are per uid with their own state
  dirs, so a device of A has no path to B's vault. Recovery code 128 bits
  (HKDF, no slow KDF needed). WebCrypto keys non-extractable in the auth
  IndexedDB. Sealed files 0600 via atomic writes in a 0700 dir. Device-mode
  mail never opens plaintext on the silent path; the desktop path
  (`enable_default` → keychain) is unchanged.
- **Rate limits** (`rate.rs`, gateway `pair`/`by_device`): strangers never
  reach a known device's windows; known sign-ins are not keyed by source
  (forgeable `X-Forwarded-For` from a local account); keyed maps bounded at
  4096 with stale sweep + overflow window; `invite_until` gating.
- **Sudoers parser**, `ADMIN_GROUPS`, re-checks at execution, nsswitch.
- **Feature split:** generator reads both attribute forms and gated `mod.rs`
  cfgs; desktop registration unchanged (P0 completeness and
  `CONVERTED_COMMAND_FILES` tests green); compiled-out code in the daemon
  (credentials → vault only, X11 → headless stubs, notifications).
  **Ran the library's tests in the no-`desktop` build for the first time:
  3121, one desktop-keychain test failed** → gated, and CI now runs them.
- **Side by side:** state dir / app home, tmux (`-L <slug>` under
  `/run/<slug>/tmux/<user>` vs the desktop's default server), control
  sockets, agent homes, ports; `check`'s `hidepid`/`proc_group`.
- **Manage CLIs ask-admin**, **VM proxy 407** (128-bit hex token, 0600,
  constant-time compare, other accounts 407; state dir 0700 keeps the seed
  private), i18n ×5, UntestedTag rows, file maps.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **high** | `commands/mail.rs::store_of` armed `vault.on_unlock` for *any* unlock note, and `on_unlock` fires at once while K is held. A passphrase-mode mailbox on a server, a missing `key.json` with sealed leftovers, or a device store whose wrap does not fit K reopened, failed identically and re-armed — one new thread per round, forever, in the daemon. | fixed `d9dd6aed`: only `DEVICE_LOCKED`/`DEVICE_NOT_SET_UP` with K absent at open waits; the listener reopens only such a store. Test `only_a_store_waiting_for_the_secrets_key_reopens_on_release`. |
| 2 | **high** (server remote projects) | The daemon's state dir `~/.local/share/<slug>-server/ssh-control` + the master's `cm-<40>.<16>` exceeds `sun_path` for **every** user name (≥108 bytes), and a system unit has no `$XDG_RUNTIME_DIR`, so `pick_control_dir` kept the too-long path: every ssh master on the server would log in and exit. Part 2's dir move made this universal (part 1: names over five letters). | fixed `f2365522`: last fallback `/tmp/<slug>-ssh-<uid>` (the unit's private `/tmp`), used only when it is a 0700 dir owned by this uid and not a link. Tests for both. |
| 3 | **medium** (desktop regression) | The proxy token changes every existing Proxy VM's user-data once → new instance id → cloud-init's per-instance `ssh` module regenerates host keys (`ssh_deletekeys` defaults on) → `accept-new` refuses the changed key in the per-VM `known_hosts`: the VM was unreachable after its next boot (the handoff's "re-provisioned once" missed this; switching egress mode had the same latent bug). | fixed `6a91339e`: a re-provision (earlier seed, different user-data) drops `<vm dir>/known_hosts` first. Test. |
| 4 | **medium** (fail open) | The sudoers check compared raw tokens: `"alice" ALL=ALL`, `bob,"alice"`, `ali\ce`, `! alice`, `%"staff"`, a quoted `User_Alias` member — all valid sudoers naming the account — were not matched, so the helper would link a sudo-capable account. | fixed `42b81fa2`: quote/escape-aware user-list tokenizer, same cleaning for alias members. Six new cases in `every_way_of_naming_the_account_counts`. |
| 5 | **medium** | `Vault::identity` minted the identity key after checking "not found" *outside* the file lock: two first uses at once (two devices enrolling, enrolment beside an unlock start) each wrote a key; a device that pinned the overwritten one fails every exchange (`untrusted`) and, being `enrolled`, never re-enrols. | fixed `2a2aa1ed`: re-read under the lock. Test `concurrent_first_uses_share_one_identity_key`. |
| 6 | **low** | A device enrolling a **new** ECDH key kept the wrap made for its old one (`wrap_missing` skips devices that have a wrap): it could never release K again (path: a save failure in `secrets.ts` after a successful enrol). | fixed `2a2aa1ed`: `enrol_secrets_key` drops the stale wrap; the route's `wrap_missing` re-wraps while unlocked. Covered in `tests/server_secrets.rs`. |
| 7 | **low** (test gap) | The daemon's no-`desktop` library tests never ran; one failed there. | fixed `ec303ea5`: test gated on `desktop`; CI step `cargo test -p <app> --no-default-features --lib --test server_secrets`. |

### Judgment calls (open, not changed)

- **Same-uid processes outside the fence can read K.** The persistent
  keyring is per uid; only the fence's seccomp blocks `keyctl`. A plain
  shell tab, the user's SSH login, or project code Tabtivity runs on the
  host (build scripts) can `keyctl` it. The design's adversary is a copy of
  the home (backup, admin `cp`), and that holds; say so in the user docs.
- **Set-up and "New recovery code" need only a session cookie**, unlike
  enrolment (pairing-key signature). A stolen browser session can already
  open an unfenced shell (→ K), so a signature would not raise the bar
  today; revisit if server shells get fenced.
- **Revoke does not rotate K**: a revoked device plus an older copy of
  `wraps.json` still opens K offline. Rotation means re-sealing the mail KEK
  and the credential store — a design step.
- **No re-pin path for the identity key**: if `secrets/identity.key` is lost
  (partial restore), every device answers `untrusted` forever. A re-enrol
  on `untrusted` would be TOFU again; needs a decision.
- **The recovery code crosses the TLS-terminating gateway in clear** (the
  device exchange does not). The gateway is root's; acceptable, note it.
- **Persistent keyring expiry** (`persistent_keyring_expiry`, default 3
  days since the last `KEYCTL_GET_PERSISTENT`): a daemon with no request in
  that time loses K; mail stays open in the running daemon (session keys),
  new opens wait for a device. Matches "or after the keyring's expiry".
- **Rate limits:** whoever knows a device id (not a secret) can exhaust that
  device's 30/min and the account's 240/min; during an invite or the 15-min
  active window a pair is forwarded, so timing/answers differ from an
  unknown account (documented residuals).
- `check`'s `proc_group` reads `/etc/group` members only (a primary-gid
  member or an LDAP group is not seen; link-time `check_account` uses the
  full group list). `mail_encryption_decline` still lets a server user keep
  a plaintext store by explicit choice.
- **Exchange table** (32 pending, 60 s): one signed-in device can make
  others' starts answer `rate_limited` for a minute.

### Gates (worktree, 2026-10-03, at `d9dd6aed` + this docs commit, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green |
| `npm test -- --reporter=dot` | **697 files, 7071 tests**, all pass (unchanged: no frontend change) |
| `cargo test --workspace -q --no-fail-fast` | **3563 passed**, 0 failed, 2 ignored, 22 binaries (src-tauri lib 3216, +3) |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` (new CI step) | **3122 + 1 passed**, 2 ignored |
| `npm run lint` | 0 errors, **31 warnings** (the same pre-existing ones) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo clippy -p tabtivity --no-default-features --lib` / `-p app-serverd` (`-D warnings`) | clean |
| `cargo build -p app-serverd` + `ldd` | libc, libm, libgcc_s, vdso, ld-linux only |
| `cargo check --workspace --target x86_64-pc-windows-msvc` (shims) | green; the same 5 pre-existing warnings |
| `scripts/brand-check.sh` | green (50 entries) |
| `scripts/privacy-check.sh 418d6f61..HEAD` | green |
| `git diff --check 418d6f61 HEAD` | clean |
| `npm run mobile:bundle` | not needed (no `mobile-web/` change in the review) |

### Live steps added to § P3 part 2's list

- After step 8 (VM proxy): a Proxy VM **made before this build** boots and
  is reachable over ssh (its host key was re-recorded; no "host key
  changed").
- On the server, a remote (ssh) project as Alice connects, and
  `ls -la /tmp/` inside her daemon's namespace (e.g. from a shell tab:
  `ls -ld /tmp/*-ssh-$(id -u)`) shows the 0700 control dir.
- A passphrase-mode mailbox on a server with the key unlocked: the
  daemon's thread count stays flat (`ls /proc/$(pgrep -u alice -f serverd)/task | wc -l`).

## #2347 per-client PTYs

*Written 2026-10-03, scheduled between P3 and P4. Base `cf642779`. Nothing
run live (AGENTS.md: never start the app or a sidecar against the user's
state dir); one test drives a real tmux server of its own (`-L t2347-<pid>`,
no config, killed and unlinked at the end). TODO #2347 and #2345 (folded
in). Rationale: [`context/web_client.md`](context/web_client.md) (§ "One PTY
per client on a shared tab", "The window follows the client in use",
"A server client's events are addressed").*

### Commits

| Commit | Content |
|---|---|
| `a4061281` | `tmux_local::window_size_policy` — the wrap sets `window-size latest` from tmux 3.2 (else `largest`, as before); `tmux_local::attach_argv` (`-u attach-session -t =<session>`, never creates); comments in `pty_bridge`/`headless`. |
| `804bc196` | `terminal/mod.rs`: `PtyMeta` (`client`, `local_tmux`, `attach_of`) on every registry entry; `join_tab` (a server client's own attach PTY `<tab>@<client>`), `PtyRegistry::{resolve, attachable, release_client}`, `route_move_window_views`; the spawn split into `spawn_pty` (the tab's, bookkeeping as before) and `launch` (shared; an attach PTY carries no tab bookkeeping and streams under the tab id); per-client event routing for `Caller::Client` (#2345). `commands/terminal.rs`: `pty_spawn` joins first and answers `attached`; `pty_write/resize/set_visible/scrollback/remove_view/watch/unwatch/kill` resolve the caller's id (three gained a `Ctx` argument; payloads unchanged). `web_client.rs`: the transport's PTY sets are gone — ownership is the registry's, keyed by the client id a resume keeps; the reap calls `release_client`. File-map rows. |
| `a4501d22` | `TerminalView`: an `attached` spawn types no rename line and re-runs no command; two cases in `AgentHeldInput.test.tsx`. |
| the commit after | TODO #2347/#2345, plan §3.5 and the P2 bullet, `context/web_client.md`, `context/tmux_sessions.md`, P2 live check 5, this section. |

### Design

- **Who gets what.** A server client (`Caller::Client(web-n)`) calling
  `pty_spawn` for tab `X`: if the registry's `X` is alive, a client of a
  local tmux session (`PtyMeta::local_tmux`, recorded when the wrap left
  `cmd = tmux`) and spawned by *another* client, the caller gets an attach
  PTY `X@web-n` — one more tmux client, at the caller's `cols×rows`.
  Otherwise the ordinary spawn, exactly as before (the caller respawning its
  own PTY, no live `X`, or a tab no local tmux holds). A previous attach PTY
  of the caller's is taken first; its view registrations move to whichever
  PTY now serves it. Desktop windows are `Caller::Local` and never reach any
  of this.
- **Ids.** The frontend keeps naming the tab id. `PtyRegistry::resolve`
  maps a server client's id to its attach PTY when it has one — or would get
  one (`attachable`), so the view a pane registers just before its spawn
  lands on its own stream. The attach route carries the tab id
  (`OutputRoute::tab`) for every event and replay. `pty_kill` of an attach
  ends only that tmux client and its route; `pty_kill_scope` still ends
  every PTY of the scope, attach PTYs included (`<tab>@…` keeps the scope
  prefix).
- **Bookkeeping stays with the tab.** Only the tab's own PTY runs the launch
  assembly (`launch_prep::prepare`: fence, MCP grants, Codex binding,
  `agent_turn::bind_tab`, resume) and the end-of-spawn cleanups; an attach
  PTY skips them in `launch`, `teardown_taken` and `kill_all`. Tab id, tmux
  session name, agent session records, Reader, headless owner and scheduler
  are untouched. Offsets for resume are per stream: a page's
  `pty_scrollback` resolves to its own PTY, whose offsets are the ones its
  chunks carried.
- **Leaving.** A page gone past `RESUME_GRACE` → `route_drop_window_views` +
  `release_client`: its attach PTYs end; its tab PTYs end too — unless
  another client still has an attach PTY onto that tab, in which case the
  tab PTY is handed to that client (`PtyMeta::client`) and resized to its
  attach's size (a resize is tmux activity, so under `latest` the window
  follows the heir, not the ghost). The handed-over PTY streams to nobody
  (no views) and ends with its new client. A reloaded page is a new client:
  it attaches to the tabs the old page still holds, and 90 s later gets them
  handed over.
- **tmux `window-size`.** `latest`, from tmux 3.2 — see the context doc.
  Verified on tmux 3.6 with a scratch server: attach, resize and typing each
  make a client the latest; when the latest leaves, the window takes a
  remaining client's size. `largest`/`smallest` measured for the record
  (largest pans the smaller client; smallest pads the larger).
- **Routing (#2345).** `emit_output`/`emit_pty_event`: for a
  `Caller::Client` context, the payload is serialized once and sent with
  `emit_json_to` to each client with a view of the route; no broadcast, no
  `:<label>` copy. `Local`/`System` contexts: unchanged (plain broadcast,
  popout copies).
- **Not covered, by design.** A remote tab (the ssh wrap is
  `new-session -A -D`, which detaches other clients), a container tab and
  every Windows tab keep one shared PTY: a second page re-spawns it as
  before, and since #2345 its output reaches the pages with a view of it.

### Live steps (localhost, Browser access on, the frozen dev build at or after the docs commit, `npm run web:bundle` run)

1. Open a local project in browser page A, open a shell tab, run `seq 1 50`.
   Open the same project in page B (a second browser tab) and the same shell
   tab: B shows the shell (tmux's redraw), A's view is untouched.
   `tmux list-clients -t <the tab's tabtivity-… session> -F '#{client_width}x#{client_height}'`
   (server mode: `tmux -L tabtivity …`) lists **two** sidecar clients (plus
   the desktop window's, if it has the tab open) with different sizes.
2. Make page B's window narrower and type in B: the shell's prompt and a
   long `ls` fit B; page A now shows the narrower window padded. Type in A:
   the window snaps back to A's width. Neither page reflows in a loop.
3. Close page B: within 90 s `tmux list-clients` drops B's client; A keeps
   working, the session stays.
4. With A and B on the tab, close page **A** (the one that opened it first)
   and wait 90 s: B keeps working, `tmux list-clients` still lists two
   clients (A's tab PTY is now B's), and an agent tab's MCP tools (e.g. the
   help server) still answer in B.
5. Reload page B: the tab reappears at once on tmux's redraw of the current
   screen, and nothing is typed into it (no second `/rename`, no re-run
   command).
6. A remote (ssh) tab in two pages: as before (one shared PTY; the second
   page's open restarts the client), output in both — the documented limit.
7. Desktop window alone: open a tab, resize, pop it out, close: unchanged.

### Gates (worktree, 2026-10-03, at `a4501d22` + this docs commit, run alone in sequence)

| Gate | Result |
|---|---|
| `npm run build` | green |
| `npm test -- --reporter=dot` | **697 files, 7073 tests**, all pass (+2: the `attached` cases) |
| `cargo test --workspace -q --no-fail-fast` | **3570 passed**, 0 failed, 2 ignored, 22 binaries (src-tauri lib 3224: +6 `terminal::client_tests`, +1 `tmux_local`, the transport ownership test rewritten) |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | **3129 + 1 passed**, 2 ignored |
| `npm run lint` | 0 errors, **31 warnings** (the same pre-existing ones; `TerminalView.tsx`'s three are older) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo clippy -p tabtivity --no-default-features --lib` / `-p app-serverd` (`-D warnings`) | clean |
| `cargo check --workspace --target x86_64-pc-windows-msvc` (shims) | green; the same 5 pre-existing warnings |
| `scripts/brand-check.sh` | green (50 entries) |
| `scripts/privacy-check.sh cf642779..HEAD` | green |
| `git diff --check cf642779 HEAD` | clean |
| `npm run mobile:bundle` | not needed (no `mobile-web/` change) |

### Gotchas / follow-ups

- **Two pages each deliver the frontend's own scheduled prompts and initial
  input** for a tab both have mounted (pre-existing since P2, not changed
  here except that an `attached` join no longer types a launch line): the
  frontend scheduler gate is "the PTY-owning main-window view", and every
  page is a `main`. Worth a TODO when P4 touches scheduling.
- **A tab PTY's spawn bookkeeping still ends when its last client leaves**
  while the tmux session lives on (as in P2): the agent's MCP tokens are
  revoked and a later page's respawn mints new ones the running agent never
  sees. #2347 only stretches that to "the last client". The headless owner
  (detached sessions) is the long-term answer.
- No UntestedTag: nothing here is a UI element; the browser client's rows
  (`server.banner.down`, `filePicker.title`) already mark the surface.
- `PtyRegistry::resolve` takes `&mut self` (it probes the tab PTY's child
  with `try_wait`); `pty_write` from a server client takes the registry lock
  once more than before. Desktop calls skip it.
