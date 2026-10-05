# Tabtivity Hosted — one server, several users, desktop and phone as thin clients

*Plan only. Nothing here is implemented. The desktop-side groundwork (the
headless owner, P1) is split out into
[`headless_owner_plan.md`](headless_owner_plan.md). Written 2026-09-29 against the tree at
`1441eb0e`, and revised the same day, against `923e0202`, after three
independent reviews (security, architecture, scope). The reviewers then
discussed each other's findings. The user then decided every other §12
question and delegated Q5.
§14 lists what changed. Every
number and file reference was measured at one of those two commits; re-verify
before building on one.*

The request: **a Tabtivity server on which several users create their own
projects and open them to others, with one agent login shared by the different
agents as today, and where connecting from phone or desktop gives the same view
as now — but every operation runs on the server, not on the local desktop.**

---

## 0. What this replaces

This plan **replaces** the earlier sync-server design (2026-07-29, removed
2026-09-29). Read it with `git show 1441eb0e:docs/tabtivity_server_plan.md`;
"the sync plan" below means that file. It designed a **different product**: a
Raspberry Pi holding bare git repos and a CalDAV server, reached over SSH, with
each person's own desktop Tabtivity doing all the work. It explicitly ruled out
most of what is asked here:

| That plan says | Why it does not carry over to this request |
|---|---|
| "Not a work host. No agent tabs, no builds" (§14) | Running the work on the server **is** the request. |
| "Desktop app in headless server mode — rejected hard", because the crate links WebKitGTK/GTK/Secret Service (§3.2) | Right for a Pi and for a multi-user service, so this plan never *ships* the desktop crate as the multi-user server: from P3 on, a Tauri-free core is split out of it (§3.2). The single-user server (P2) does run the WebKit-linked binary without a window, because the Mobile sidecar already does exactly that (`tabtivity --mobile-host`, `main.rs:21-45`). The target is a real x86_64/aarch64 Linux server. |
| "No HTTP server… the codebase has no server framework at all" (§3.2) | **Stale.** Tabtivity Mobile has since added one: `axum 0.8` with `ws` (`src-tauri/Cargo.toml:217`), a 49-route API (`services/mobile_control/host.rs:3409`), device-key pairing, rate limits, a baked PWA, and a tmux PTY bridge. |
| "No inbound listening socket in the client. Ever." (§14) | Already broken, deliberately, by `tabtivity --mobile-host` (`src-tauri/src/main.rs:21`). |
| "No shared agent sessions, no shared terminals" | **Kept** (§13). Sharing a *project* is not sharing a *session*. |
| Sharing through a bare repo per project, one clone per member (§6.1) | **Kept, moved onto the server** (§6). The first draft of this plan replaced it with a group-writable shared tree and a worktree per member; review showed that shape opens cross-user code execution through `.git` and cannot be enforced (§14). |
| Writable sharing gated on hooks / agent-surface review / containers (§9) | **Kept in intent, rewritten** (§6.5). Tabtivity's own git already runs hookless; what is left is git typed in shells and run by agents. The container gate is replaced by the uid boundary plus the fence, and §6.5 says why. |

`docs/tabtivity_remote_plan.md` is also superseded, and now says so: Mobile
shipped its shape, and this plan covers the rest.

The sync plan's backlog, `todo/group-z-server.md`, has already been rewritten
for this plan. Its design-specific items (#173–#199) are gone, and only the
design-independent prerequisites #169–#172 remain (**Q10**, answered).

---

## 1. The design in one page

```
  desktop browser / Tabtivity shell            phone PWA (unchanged)
          │  HTTPS + WSS                         │  HTTPS
          └──────────────┬───────────────────────┘
                   tabtivity-gateway               (one per server, user tabtivity-gw)
                   TLS · device auth · routing · shares DB · audit · static assets
                   │ /run/tabtivity/users/<uid>.sock  (0660 user:tabtivity-gw, SO_PEERCRED)
        ┌──────────┴──────────────────┐
  tabtivity-user-alice.slice        tabtivity-user-bob.slice       (MemoryMax, TasksMax)
   ├ tabtivity-serverd@alice          ├ tabtivity-serverd@bob      (runs AS that uid; restartable)
   │   workspace owner, core cmds  │
   └ tabtivity-tmux@alice             └ tabtivity-tmux@bob         (tmux -L tabtivity; agents live here)
  ~alice/.local/share/tabtivity      ~bob/.local/share/tabtivity
  ~alice/tabtivity/projects/*        ~bob/tabtivity/projects/*    (clones; private, 0700 homes)
        └──── fetch ── /srv/tabtivity/shared/<id>.git ── push via tabtivity-hub (ref rules)
```

Seven decisions carry it:

1. **One daemon per user, running as that user's Unix uid.** The OS, not
   Tabtivity, keeps users apart. This is the JupyterHub shape (a hub, a spawner,
   and one single-user server per person), and it is right for the same
   reason: every per-user assumption in the codebase stays true inside one
   daemon. That covers `state_dir`, agent homes, the fence, `projects.json`,
   `exec_trust`, tmux, `$HOME`, and the backend's 109 process-wide statics,
   which would be cross-user hazards in one shared daemon. The bubblewrap
   fence stays as a *second* layer, per scope. It is not a multi-tenant
   boundary: it has leaked the kernel keyring and abstract sockets this month
   alone, while a uid is a real boundary. **The daemon belongs to its user**: shell
   tabs are unfenced (`docs/context/agent_authority.md`), so a user can
   replace their own daemon. Everything the gateway, the root helper or the
   credential keeper receives from a daemon is untrusted input (§3.1, §4.3).

2. **The frontend is the existing React app, nearly unmodified, over a
   WebSocket.** Every `invoke()` and `listen()` in `@tauri-apps/api` v2
   funnels through `window.__TAURI_INTERNALS__` (plus
   `__TAURI_EVENT_PLUGIN_INTERNALS__` for unlisten, `src/test-setup.ts:28-29`).
   `src/dev/perfMonitor.ts:20` already patches the first, and
   `src/test-setup.ts:21` already stubs both. A web entry point installs
   WebSocket-backed implementations before the app loads, so the 185 frontend
   files that import `@tauri-apps/api` need no transport edit. Four things do
   need work:
   - browser adapters for the three plugins (`dialog`, including `confirm` and
     `message`; `drag`; `notification`) and for the window APIs
     (`getCurrentWindow` in 22 files);
   - **one real audit.** `lib/platform.ts:14-27` derives `IS_WINDOWS` and
     `IS_MAC` from `navigator`, and 25 files use them for server-side
     decisions: tmux persistence, path joins, install commands. They split
     into `CLIENT_OS`, for keys and shortcuts, and `HOST_OS`, taken from
     `server_capabilities` (§3.5).

3. **Live state moves out of the window into one headless owner. This is the
   real work, and it comes first.** Today the React app spawns every
   terminal, fires every timer, saves the tab set as one whole snapshot and
   answers the phone, so with no client nothing is scheduled and with two
   every schedule fires twice. **The owner is the existing per-user Mobile
   sidecar** (`tabtivity --mobile-host`), grown into a `workspace` service. That
   work is desktop work, worth doing with no server, and has its own plan:
   [`headless_owner_plan.md`](headless_owner_plan.md). On the server the same
   code becomes the daemon (§3.4).

4. **The backend becomes `tabtivity-core`, a Tauri-free crate, plus two thin
   hosts, by P3.** The count at `923e0202`:
   - `generate_handler!` registers **658** commands (`lib.rs:1333`).
   - About **388** take no Tauri type at all.
   - **57** take no Tauri type in their signature but use `tauri::` in the
     body (`async_runtime::spawn_blocking`, `ipc::Response`), a mechanical
     swap.
   - **211** take `AppHandle`, `State<>` or a `Window`.
   - `services/` is **not** yet `AppHandle`-free: seven modules and
     `terminal/mod.rs` take a handle (§3.2).

   One command table feeds both Tauri's `generate_handler!` and the daemon's
   dispatcher, so the two cannot drift apart. The split is mechanical, runs
   in parallel from P1, and is needed only once the gateway and the per-user
   daemons separate (P3).

5. **Every user signs in to their own agent CLIs; that is the default.** This
   is today's `agent_auth` running unchanged in each user's daemon: one login
   per CLI per user, shared across that user's scopes and never seen by
   anyone else. The admin *may* additionally offer a credential per CLI,
   either an API key (P3b) or, at the admin's own risk, a shared consumer
   login (P5). The user's own login is always available. (User decision,
   2026-09-29, replacing the first draft's "the admin signs in for everyone",
   §5.)

6. **Mail, calendar and todo are per user, private by default.** They live
   in the user's own `state_dir`, under that user's uid, and the fence hides
   them from every agent, as today (`agent_fence.rs:1170`).
   - **Mail is always private**; there is no mail sharing of any kind.
   - A user can **open a calendar or a todo list** to named users, as viewer
     or editor. The shared copy then lives in a small `tabtivity-calendar`
     service that checks each caller's uid, never in another user's daemon.
   - The admin (server-wide) and each user (for themselves) can **switch any
     of the three off**.
   - Mail's store key and saved passwords are released by the user's own
     devices and held in memory only (§6.7–6.8). (User decisions,
     2026-09-29.)

7. **A shared project is a bare hub repo on the server, and every member works
   in their own clone.** `/srv/tabtivity/shared/<id>.git` is owned by a service
   uid, `tabtivity-hub`. Members fetch through a named-user read ACL and push
   through the hub service, which enforces who may move which ref (the
   gitolite shape). The owner's project never moves. No working tree is ever
   writable by two uids, no `.git/config` or hook is ever writable by another
   member, and revoking removes one ACL entry. A single shared tree
   ("pair mode") and in-repo worktrees are later options (P5).

**Size.** P1, one headless owner, is the real risk and comes first; it pays
off on the desktop even if no server ships. P2, a single-user server grown out
of the sidecar, proves the thin-client design. The crate split runs alongside
and is needed by P3. Multi-user and sharing are then mostly operating-system
plumbing and authorization, not new subsystems. The desktop app keeps working
standalone throughout, and server mode is additive.

---

## 2. What already exists and carries over

| Capability | Where | What it gives |
|---|---|---|
| **A headless per-user Tabtivity process** | `tabtivity --mobile-host` (`main.rs:21-45`, runs `tabtivity_lib::services::mobile_control::host::run`), a systemd user unit | The P1 owner and the P2 server start as this process. It already runs without a window and survives the desktop closing. |
| **HTTP + WebSocket server** | `services/mobile_control/host.rs` (5721 lines, 49 routes, router `:3409`) | axum routing, body limits, security headers, static assets, WebSocket upgrade. It reads the user's state directly, so at P3 it **splits**: pairing, auth, limits, router and push go to the gateway; `discovery`, `pty_bridge`, `files`, `inbox`, `outbox` and `desktop_images` go to the daemon (§3.1). It keeps serving standalone Mobile: one codebase, not a fork. |
| **Sidecar ↔ desktop bridge** | `commands/mobile_control.rs` (unix socket plus token) | The shape of gateway ↔ daemon, already in use. |
| **Device pairing + challenge login** | `mobile_control/auth.rs`, routes `/api/v1/pair`, `/auth/challenge`, `/auth/session` | Single-use pair code → **ECDSA P-256** device key (`mobile-web/src/auth.ts:191`) → signed-nonce session, with separate rate budgets so a pair flood cannot starve logins. **The v1 identity system, already written.** |
| Rate/size limits | `mobile_control/limits.rs` | Per-device budgets, frame caps (`MAX_INPUT_FRAME`, `MAX_CONTROL_MESSAGE`). |
| **tmux PTY bridge** | `mobile_control/pty_bridge.rs` (937 lines) | Attaches a WebSocket to an exact tmux session with bounded frames, sheds the oldest output under flood, and re-checks authorization every second. Only **one viewer per session**: a new one evicts the old (`BusyGuard`, `EVICTION_WAIT`). |
| Web Push | `mobile_control/push.rs` | Phone notifications without the desktop. |
| TLS via Tailscale Serve | `mobile_control/config.rs:286` `verify_tailscale_serve` | Real HTTPS without a PKI or a self-signed override. |
| **Every tab can live in tmux** | `services/tmux_local.rs`; `docs/context/tmux_sessions.md` | Process lifetime independent of any client, reattach by name, and a launch-script fallback past the 16 KB argv limit. Uses the **default** tmux socket today; only tests pass `-L` (`tmux_local.rs:899`). |
| **Per-scope agent homes, shared login, Tabtivity-wide layer** | `services/agent_home`, `agent_auth.rs`, `agent_global` | "Log in once, every agent tab uses it" for one user. Runs unchanged inside each user's daemon: per-user sign-in is the server default (§5). |
| **Sign-in tabs** | `mobile_control/sign_in.rs` (QA 31bk) | A tab running a CLI's login command from a remote client, with a `sign-in-callback` relay for OAuth redirects to `localhost`. The per-user sign-in flow on the server (§5.1). |
| **Per-user mail, calendar, todo** | `commands/calendar.rs` (`<state_dir>/calendar.json`, events and tasks), `commands/mail.rs:94` (`mail_dir()`, never inside a project), `services/mail_crypt.rs` | Already per `state_dir` and hidden from agents (`agent_fence.rs:1170`). Separation between users comes from the uid. New on the server: calendar/todo sharing through `tabtivity-calendar`, opt-out switches, and mail's store key (§6.7–6.8). |
| Fence, fail-closed | `services/agent_fence.rs` | Per-scope containment inside a user's uid. Mounts `/` read-only (`:1101-1103`) and gives agents a private `/run` (`:1122-1125`). |
| Spawn authority from `projects.json` | `commands/terminal.rs:257` `pty_spawn` → `sandbox::enforce_spawn_authority` | The renderer can't declare its own authority. On a server the "renderer" is a remote browser, so that property becomes load-bearing. |
| `state_dir` from `$HOME` / `TABTIVITY_STATE_DIR` | `storage.rs:153` | A daemon started as uid `alice` gets `~alice/.local/share/tabtivity` with no code change. |
| Hardened git, `exec_trust`, `local_loss` | `commands::git::hardened_git_command_in` (pins `core.hooksPath=` on every call that isn't trust-gated, `git.rs:95-111`), `services::exec_trust` (`<state_dir>/exec_trust.json`), `services::local_loss` | Per user. Tabtivity's own git already runs hookless. |
| Terminal event bus | `src/lib/terminal/terminalBus.ts:47`; `src-tauri/src/terminal/mod.rs` (16 ms batching, hidden-pane digests, `route_scrollback` sharing one offset timeline with live output, `:434`) | One stream per client; byte-offset resume on reconnect (§3.5). |
| `__TAURI_INTERNALS__` seam | `src/dev/perfMonitor.ts:20`, `src/test-setup.ts:21,28-29` | Proof that the IPC surface can be intercepted at two objects. |
| Opaque ids for the phone | `mobile_control/discovery.rs` catalog | "Raw ids/paths never cross the browser API", built for one client type. |

---

## 3. Architecture

### 3.1 Processes and deployment

**Linux only.** The server has no Windows or macOS target. Clients can be
anything with a browser.

```
/etc/systemd/system/tabtivity-gateway.service     User=tabtivity-gw, the only listening port
/etc/systemd/system/tabtivity-users.slice         ceiling for the whole population
/etc/systemd/system/tabtivity-user-@.slice        per user: MemoryMax, TasksMax, CPUWeight
/etc/systemd/system/tabtivity-serverd@.service    User=%i, Slice=tabtivity-user-%i.slice
/etc/systemd/system/tabtivity-tmux@.service       User=%i, Slice=tabtivity-user-%i.slice, tmux -L tabtivity
/etc/systemd/system/tabtivity-hub.service         User=tabtivity-hub, push service for shared repos (§6)
/etc/systemd/system/tabtivity-calendar.service    User=tabtivity-cal, shared calendars and todo lists (§6.7)
/etc/systemd/system/tabtivity-auth-keeper.service User=tabtivity-auth, only if the admin offers credentials (§5.4)
```

These are **system** template units, so no `enable-linger` is needed.

- **The gateway** runs as its own unprivileged user. It terminates TLS (or
  sits behind Tailscale Serve, **Q8**), authenticates
  devices, serves the web bundle and the PWA, and forwards each connection to
  **the caller's own daemon only**. It holds the shares database and the
  audit log. It links no core services, and it reads no user files: every data
  path (`discovery`, `pty_bridge`, `files`, `inbox`, `outbox`) moves into the
  daemon at the host.rs split.
- **The daemon socket** `/run/tabtivity/users/<uid>.sock` is `0660
  <user>:tabtivity-gw`. The daemon accepts a connection only when `SO_PEERCRED`
  says it comes from `tabtivity-gw`, so the user's own unfenced shells cannot
  forge a `caller`. Fenced agents cannot see it at all, because they get a
  private `/run`.
- **The gateway is a router, not a trust root for the daemon.** When a
  WebSocket opens, the daemon issues its own nonce, the device signs it, and
  the daemon checks the signature against the device public keys in its own
  `state_dir`. A compromised gateway can intercept live sessions, but it can
  neither mint new ones nor act as a user who is not connected (§4.4).
- **Privileged operations go to `tabtivity-admin-helper`**, never the gateway:
  - creating or linking a Unix account and making its home `0700`;
  - starting and stopping a user's units (the gateway cannot run `systemctl
    start` unprivileged);
  - creating a hub repo and setting a named-user ACL;
  - installing an agent CLI into the server-wide root (§5.1).

  It is a small root-owned binary behind a polkit rule and accepts a fixed
  verb set. Its hard rules:
  - **Ids only, never paths:** verbs take user and share ids from the
    gateway database, never a path a daemon supplied.
  - **It never copies or chowns a user's tree.** It creates empty targets,
    and any copy runs as the owning uid.
  - Every walk uses `openat` and `O_NOFOLLOW`.
  - It links only accounts with uid ≥ 1000 in the `tabtivity-users` group, and
    refuses root, system accounts and sudoers.
- **Per-user daemons** are started through the helper on the user's first
  login. A daemon with no client is stopped after an idle timeout. The agents
  are unaffected, because they live in `tabtivity-tmux@`, not in the daemon.
- **tmux runs on a dedicated socket, `tmux -L tabtivity`, in its own unit.**
  With the default socket, a user who also SSHes in and runs tmux could end up
  hosting Tabtivity's sessions in their SSH-started server, outside every limit.
  `tmux_local` and `pty_bridge` take the socket name from one place. Because
  tmux has its own unit inside the user's slice:
  - the slice's `MemoryMax`/`TasksMax` still cover every agent;
  - the daemon can crash, restart or upgrade at any time and reattach by
    name;
  - **nothing outlives stopping the user's slice.**
- **Why not one multi-user daemon.** Every command would have to switch uids
  or re-check ownership, and one missed check becomes a cross-user bug.
  Per-uid daemons make "Alice's request touched Bob's file" something the
  kernel refuses, not something code has to remember.
- **Why not a container per user.** It is a legitimate variant (rootless
  Podman per user, **P5**), but not needed for isolation. Nesting bubblewrap
  inside a container needs user namespaces the container may not grant; memory
  `project_codex_fence_no_nested_sandbox` shows how that fails.
- **Shutdown.** The desktop rule "nothing outlives a clean quit" becomes
  "nothing outlives stopping the user's slice". A daemon stop runs the
  teardown `RunEvent::Exit` runs today (`lib.rs:2176`) for everything except
  the tmux unit. A *client* disconnecting stops nothing.

### 3.2 Crate split

```
Cargo.toml (workspace; today members = ["src-tauri"])
  tabtivity-core/      schema, storage, paths, services/*, terminal/, command bodies
  src-tauri/        the desktop app: Tauri wrappers + a Tauri EventSink, window-only commands
  tabtivity-serverd/   per-user daemon: frames over a unix socket, EventSink pushing to clients
  tabtivity-gateway/   auth/router half of mobile_control/host.rs; no core services linked
```

**`CoreCtx`** is the only thing a command body may use in place of Tauri. It
is a concrete type, not a generic trait, so command bodies are not compiled
once per host:

```rust
pub struct CoreCtx {
    pub state: Arc<CoreState>,        // every managed singleton, both hosts construct it
    pub events: Arc<dyn EventSink>,   // emit / emit_to(ClientTarget)
    pub caller: Caller,               // which client/device; Local on desktop
}
```

**One command table** replaces the list at `lib.rs:1333`:

```rust
tabtivity_commands! {
    core:   settings::get_settings, fs::read_dir, terminal::pty_set_visible, …,
    client: clipboard::*, print_native::*, screenshot::*, subwindow::*, …,
    admin:  openvpn::*, global_machines::*, vm::*, …,
}
```

The macro emits Tauri's `generate_handler![…]` for every entry and the
daemon's dispatcher for `core` entries only. It also generates
`src/lib/transport/commandClasses.ts`, which the browser shim reads. Argument
keys stay the frontend's camelCase (AGENTS.md convention).

**Migration mechanics.**

- About 388 commands move as they are. The 57 with `tauri::` in the body get
  a mechanical swap: `tauri::async_runtime` becomes tokio. The four commands
  returning a raw `tauri::ipc::Response` (`fs.rs:1702`, `screenshot.rs:104`)
  and the one taking a raw `ipc::Request` (`fs.rs:1580`) move to binary
  frames (§3.5).
- For the 211 coupled ones, `app: AppHandle` becomes `ctx: &CoreCtx`, and
  `State<'_, T>` becomes a field of `CoreState`. The managed singletons
  (`lib.rs:1099-1115`: `pty_registry`, `workspace`, `fs_watch`,
  `remote_pool`, `git_peer`, `mail_state`, `caldav_state`, …) become
  `CoreState` fields.
- **Seven services and the terminal core take a Tauri handle today** and are
  converted first:
  - `git_peer.rs:3275/3289`, `sync_auto.rs:111/302`,
    `worker_sync.rs:387/610`, `agent_turn.rs:437`, `project_runtime.rs:57`,
    `remote_usage.rs:213`;
  - `window_service.rs:13`, which takes a `WebviewWindow` and stays
    `client`;
  - `terminal/mod.rs`, which emits at `:470`, `:1053` and `:1103`.
- **Of the 15 `Window`-taking commands, 8 are not window operations.**
  `pty_set_visible` (`terminal.rs:995`) uses the window label as the viewer's
  identity. Ollama `complete_text` (`ollama.rs:3434`) emits back to the
  calling window, and the six `copilot_*` commands are editor completion. For
  these, `Window` becomes `ctx.caller` plus `emit_to(ClientTarget)`, and they
  are classed `core`. The other seven stay in `src-tauri/` as `client`.
- Do it one `commands/*.rs` file at a time. The desktop stays shippable after
  every file.

### 3.3 Classifying all 658 commands

Every command gets exactly one class. A unit test fails if a command in the
table has none (the same shape as the `untested` register's completeness test).
There is no default class, because a forgotten command must not quietly land in
`core`. **The table and its test exist before any command is reachable over a
network (P0).**

| Class | Runs where | Examples | On the server |
|---|---|---|---|
| `core` | the user's daemon | projects, fs, git, terminal (incl. `pty_set_visible`), agents, search, tex, viewers' backends, skills, schedules, copilot, ollama completion, the root console **Host** session (under the user's own uid, no sudo, **Q6**) | exposed |
| `client` | the machine the user sits at | clipboard, native print, screenshot, subwindows/popouts, os clock, power, sysstat/gpustat of *this* machine, IDE launch, open-outside | not exposed; browser adapter or hidden |
| `admin` | the server as a whole | OpenVPN (machine-wide), global machines, VMs, Docker, app update, dev build, admin-provided agent credentials and server-wide CLI installs | admin role only, or disabled (§9) |
| `off` | nowhere in server mode | keychain unlock, anything D-Bus-session-bound, the whole-document saves that §3.4 replaces | refused with a named reason |

The class also drives the UI. The frontend asks once (`server_capabilities`,
following the `browser_capabilities` precedent) and hides a control whose
command is unavailable, naming why, instead of letting it fail. The same call
carries `HOST_OS`.

### 3.4 Live state: from the window to one headless owner

The move itself, with its ownership table, protocol, migration order and
tests, is [`headless_owner_plan.md`](headless_owner_plan.md) (split out
2026-09-29). It lands on the desktop first, where the owner is the Mobile
sidecar; on the server the same `workspace` service runs inside the user's
daemon. What the server adds to that plan:

- **Spawn policy follows `HOST_OS`**, taken from `server_capabilities`, never
  the connected client's OS (§1.2).
- **Todo, calendar, alerts and the mail overview** live in the user's own
  daemon. Shared calendars and todo lists go through `tabtivity-calendar`. Mail
  never leaves the user's daemon; no presence event or gateway record carries
  any of it (§6.7).
- **Per-client layout** (decided, Q4): the tab set is shared across a user's
  clients, while pane layout, focus, scroll and terminal size are per client.
- **No second client connects before `save_tab_layout` is refused**, which is
  why the owner plan's group 0 comes before P2.

### 3.5 Transport

**Client ↔ gateway:** one WSS connection per window after an authenticated
HTTPS session. Frame kinds:

```
→ {t:"call",  id, cmd, args}               ← {t:"ret", id, ok | err}
← {t:"event", name, payload}               (only events the client subscribed to)
→ {t:"sub"/"unsub", name}
↔ binary: [u8 kind][u32 stream-id][bytes]  terminal I/O, bulk call bodies/returns
```

- **Terminal I/O** stays on the existing 16 ms batching with a size cap and
  hidden-pane digests (`src-tauri/src/terminal/mod.rs:6-71`), sent as binary
  frames. `pty_set_visible` keys visibility by `caller`, not by window label.
- **Terminal size is per client.** Today `pty_resize(id, cols, rows)`
  (`terminal.rs:980`) sets one size per terminal, so two clients of
  different sizes would fight. Each web client gets its own tmux attach,
  because tmux already sizes per client. The phone's `pty_bridge` keeps its
  one-viewer rule, so "continue from the phone in the same tab" means the
  phone takes that tab over, and the other client sees that it was taken.
- **Reconnect resumes by byte offset.** The daemon's terminals never drop,
  so there is nothing to "reattach". The client sends its last offset and the
  daemon replays from `route_scrollback` (`terminal/mod.rs:434`), which
  shares one offset timeline with live output (test at `:1725`). The
  workspace resyncs by version (§3.4).
- **Backpressure.** Each client stream has a bounded queue. On overflow, the
  terminal falls back to digests and then sheds the oldest output, the way
  `pty_bridge` already does, while input is acknowledged. The gateway opens
  one unix connection per client, so a slow phone cannot stall the laptop.
- **Bulk data.** Binary call bodies and `Vec<u8>` returns (`fs.rs:606`,
  `:1714`) travel as binary frames. Large downloads use an HTTP ticket, never
  JSON number arrays.
- **Latency budget:** keystroke-to-echo under 50 ms on a LAN and under
  150 ms on a good WAN, measured with the dev perf monitor, which already
  times every invoke.
- **Link down.** One global "server connection lost" banner appears. Every
  pending call rejects with a typed `disconnected` error. **No invoke is sent
  while the link is down**, because replaying a queue of stale mutations is
  worse than an error. A global pause also stops the 83 `setInterval` pollers
  (64 files), so they go quiet instead of each raising an error.
- **Session lifetime.** The gateway re-checks each WebSocket's session
  periodically, following `pty_bridge`'s one-second authorization tick. When a
  device is revoked, its sockets close.
- **Gateway ↔ daemon:** the same frames over the unix socket, with a
  **protocol version** in the handshake. A daemon one release behind (N-1) is
  still served, because live daemons are not forced to restart for a
  feature release (§8). The gateway adds `{caller:{device_id, client_id}}`
  and never rewrites `cmd`, so the class check lives in exactly one place,
  the daemon.

**The browser shim** (`src/lib/transport/wsInternals.ts`, installed by a new
`src/main-web.tsx` before anything imports `@tauri-apps/api`):

| `__TAURI_INTERNALS__` member / plugin | Web implementation |
|---|---|
| `invoke(cmd, args)` | A `call` frame. The class comes from the generated `commandClasses.ts`: `core` commands go to the daemon, and `client` commands go to the browser adapter or reject `unsupported`. |
| `transformCallback` / `unregisterCallback` | a local callback table, as in Tauri's own |
| `plugin:event\|listen/unlisten/emit`, `__TAURI_EVENT_PLUGIN_INTERNALS__` | `sub`/`unsub` frames; `emit` becomes a daemon call. |
| `plugin:dialog\|open/save` (21 files) | A **server-side file picker**: a dialog that browses the *server's* filesystem through the existing `fs` commands, reusing `ProjectFilesView`'s tree. A browser `<input type=file>` would pick from the *laptop*, the wrong machine. "Upload from this computer" is a separate, explicit button. |
| `plugin:dialog\|confirm/message` (5 files) | the shared `PromptDialogs` |
| `plugin:notification` | Web Notifications API |
| `plugin:drag` (drag a file out to the OS) | a download |
| `plugin:window\|*`, `webviewWindow`, `getCurrentWindow` (22 files) | `window.open` of the same bundle with `?popout=<kind>`. Each popout is its own connection to the same workspace, which **removes** the need for `detachedContext` write forwarding. |
| `convertFileSrc` | no production caller; stubbed |
| `metadata` | a fixed descriptor with `currentWindow` and `currentWebview` labels per client |

**User content is served from a separate origin.** Any file the gateway
serves by ticket — an "open in new tab", a download, or a preview a viewer
cannot sandbox itself — comes from a separate user-content origin with
`Content-Security-Policy: sandbox`. Active types (HTML, SVG, XML) are sent as
`attachment`. Otherwise a co-member's HTML file would run on the app's own
origin. The in-app previews are already sandboxed
(`FileViewerPane.tsx:5877-5881`); a top-level tab is not.

Verify the member list against the pinned `@tauri-apps/api` version before
building. The shim is written against its internals, so a Tauri upgrade gets a
checklist row in `docs/third_party_update_checklist.md`.

### 3.6 Storage layout on the server

```
/home/<user>/                                0700 — other users see nothing
  .local/share/tabtivity/                        state_dir: projects.json, sessions/, agent-homes/,
                                              agent-auth/ (the user's own logins), agent-global/,
                                              exec_trust.json, calendar.json (events + tasks),
                                              mail/ + secrets/ (sealed, §6.8), devices/ (device
                                              signing keys, ECDH keys and key wraps, §3.1, §6.8) …
  tabtivity/projects/<slug>/                     own projects and clones of shared ones
/srv/tabtivity/shared/<id>.git                   bare hub, owned by tabtivity-hub; config/hooks/info
                                              root-owned read-only; members get named-user ACLs
/opt/tabtivity/agents/                           server-wide CLI installs, owned by tabtivity-cli,
                                              read-only to users, bound read-only into fences
/var/lib/tabtivity-auth/                         0700 tabtivity-auth: admin-provided credentials only (§5.4)
/var/lib/tabtivity-calendar/                     0700 tabtivity-cal: shared calendars/todo lists + ACLs (§6.7)
/var/lib/tabtivity-gateway/                      0700 tabtivity-gw
  gateway.db                                  users, devices, shares, invites (SQLite, WAL —
                                              the mail_store precedent)
  audit/                                      append-only, bounded retention (§8)
/run/tabtivity/users/<uid>.sock                  daemon sockets, 0660 <user>:tabtivity-gw
/run/tabtivity/calendar.sock                     tabtivity-calendar, SO_PEERCRED
```

**Home directories must be `0700`.** Many distributions default to `0755`, which
would let every user's fence (whose host root is mounted read-only,
`agent_fence.rs:5`) read every other user's projects and `state_dir`. The admin
helper sets it on enrolment and **refuses to enrol** a user whose home it
cannot make private.

**Server-side persistence.** `write_json_atomic` already calls `sync_all` on
the staged file (`storage.rs:117`). What is missing is an fsync of the
**parent directory** after `persist` (`:118`), so a crash can lose the
rename. On a multi-user box that runs for months, that fix is a hard
prerequisite (#172, H0 of [`headless_owner_plan.md`](headless_owner_plan.md)).

---

## 4. Identity, authentication, authorization

### 4.1 Accounts

- **A gateway user is one Unix account.** `tabtivity-gateway user add <name>`
  (admin CLI) goes through the helper. It creates or links the Unix user
  (uid ≥ 1000, in `tabtivity-users`, not a sudoer), makes the home `0700`,
  installs the user's slice and units, and prints a **single-use invite
  code**.
- **Login method v1: device keys, reusing mobile pairing.** The invite code
  pairs a first device. That device (browser or phone) makes an ECDSA P-256
  key, held in IndexedDB as a non-extractable WebCrypto key, and logs in by
  signing a nonce, which is the `auth.rs` flow as it stands. The public key
  goes to the gateway **and** to the user's daemon (§3.1). Further devices
  are paired from an existing one, and revoking a device is one row in each.
- **Login method later: OIDC** (for example a university's SSO), **P5**.
  The sync plan rejected OIDC for a home Pi because it moves the trust root
  off the user's hardware. For an institutional server, the institution's
  identity *is* the right trust root. OIDC still only **binds a device key**;
  the session model does not change.
- **Passwords:** none for the web login. The standing "passwords are never
  persisted by default" rule concerns credentials Tabtivity *uses* (SSH, VPN,
  mail), and is §9's business.

### 4.2 Sessions and the browser

- The session cookie is `HttpOnly; Secure; SameSite=Strict` and
  short-lived, and it is refreshed by re-signing a nonce. It is bound to the
  device id.
- The WebSocket upgrade checks the cookie **and** an exact `Origin` match
  (`host.rs:163, 379` already does both). Without the Origin check, any page
  the user visits could open a socket carrying their cookie: cross-site
  WebSocket hijacking (CSWSH).
- The daemon then verifies the device itself on socket open (§3.1), and the
  gateway closes sockets of revoked devices (§3.5).
- The web bundle ships under the same strict CSP the desktop has
  (`project_not_dogfooded`: the CSP is the real perimeter). A web client is
  exposed to far more than a Tauri window, so the CSP gets a review of its
  own. **That review, plus the class table, is a precondition for exposing
  any `core` command beyond localhost** (P2).

### 4.3 Authorization, in one sentence

**The gateway routes a request only to the caller's own daemon. That daemon
can only touch what its uid can, so sharing is decided by ACLs on hub repos
that the admin helper sets, never by one user's request reaching another
user's daemon.**

The consequences:

- There is no ACL check in 658 commands. The daemon trusts its caller *as the
  owner*, which is exactly what the desktop IPC does today, and the kernel
  bounds what the owner can reach.
- The gateway's own authorization surface is small and testable: who may pair
  devices, who may create or accept shares, and who is admin.
- **The daemon is its user's, not Tabtivity's.** Anything it tells the gateway,
  the helper, the hub or the credential keeper is untrusted:
  - presence is attributed by the socket's peer uid, not the payload;
  - share requests name share ids, not paths;
  - the hub checks refs against the pusher's peer uid;
  - the credential keeper, if the admin offers a shared login, never adopts
    a user's credential file (§5.4).
- **This deliberately relaxes one invariant for one client type.** The phone
  API keeps its opaque ids (`mobile_control` invariant) and its route prefix.
  The web desktop client gets raw paths and project ids of **its own user's**
  projects on a separate route prefix, because the desktop UI is built on
  them and the caller is authenticated as their owner. Raw ids still never
  leave the user's own daemon toward another user.

### 4.4 Threat model, the rows that are new

| Adversary | Can | Denied by | Residual |
|---|---|---|---|
| **Another user** (B, about A) | Anything their uid can, including an unfenced shell | Separate uid, `0700` homes, `0660` daemon sockets with a peer-uid check, gateway routing | Anything world-readable on the host; shared-project content by design (§6) |
| **Another user, through host-shared channels** | Loopback TCP ports, abstract unix sockets, other users' `/proc/*/cmdline`, `/tmp`, `/dev/shm` | An inventory of every loopback listener: each needs a token or moves to a unix socket (root MCP `commands/root_mcp.rs:385` has a token; `vm_proxy.rs:178`, CLI OAuth callbacks, per-user ollama on `127.0.0.1:11434` must be checked). Also `/proc` mounted `hidepid=invisible`, `PrivateTmp=` on the units, and the sign-in relay (`sign_in.rs:57-60`, which today fetches any loopback port ≥ 1024) restricted to a listener owned by the caller's uid (§5.1) | Abstract sockets have no permissions (the fence's Landlock helper covers agents, not shells); kernel privilege escalation, since every user has a shell |
| **A co-member of a shared project** | Push commits to their own branch in the hub | Their writes land only in the hub, through `tabtivity-hub`'s ref rules; nobody else's tree or `.git` is writable to them; `exec_trust` is per user | Content you merge. Instruction-level steering of your agent through `CLAUDE.md` etc. once merged (§6.5, gate 2) |
| **A co-member, via a file served to the browser** | Author HTML/SVG in the project | Separate user-content origin with `CSP: sandbox`, active types as attachment (§3.5) | None known |
| **A web page the user visits** | Make the browser send requests with the user's cookie | `SameSite=Strict`, Origin check on WS and on every state-changing POST, CSP | A browser 0-day |
| **Stolen unlocked laptop** | The device key in IndexedDB | Per-device revocation, which closes live sockets | The window until revocation |
| **A prompt-injected agent** | Everything its fence allows, as its user | The fence (scope), the uid (user); the fence hides `/srv/tabtivity/shared` except its own project's hub (§6.3) | The user's own data in that scope, as today |
| **Another user, about your agent logins, mail, private calendars and tasks** | Nothing beyond "another user" above | They live only in your `0700` `state_dir`; presence, audit and admin status never carry them (§6.7) | None beyond the host-channel row |
| **A user you opened a calendar or todo list to** | Read it (viewer), or add, edit and delete its events and tasks (editor) | `tabtivity-calendar`'s per-uid ACL; mail and file links stripped; their text rendered as plain text with size limits; agents read-only (§6.7) | What they copied before a revoke; an editor can vandalise the shared calendar |
| **Any user, about an admin-provided credential** (only if the admin offers one, §5.4) | Read the key or login replica their own agents are given | Nothing: the CLI must read it. Broker tokens (P5) or access-only replicas bound it | Per-use cost on the admin's key; a shared consumer login's terms (§5.4) |
| **A compromised gateway** | Intercept and act inside live sessions; see every device's traffic | Daemons verify device signatures themselves (§3.1); the gateway links no core services and runs no root verbs directly | Live-session interception while connected |
| **Server admin** | Everything | Nothing technical, except for mail and saved passwords: they are sealed with a key the user's devices release (§6.8), so the admin reads them only while the user's daemon holds the key unlocked | The admin can read everything else, and enrolment says so in one sentence |
| **The public internet** | Whatever the gateway port exposes | TLS, pairing-only enrolment, rate limits (`limits.rs`) | Gateway bugs. Keep it small, in a memory-safe language, with no core services linked in. |

---

## 5. Agent logins

**Decision (user, 2026-09-29):** every user signs in to their own agent CLIs,
and that is the default. The first draft had the admin sign in once for
everyone. The review found that design risky: its write-back path was
unauthenticated, and consumer terms forbid making an account available to
others (§14). The user then made per-user sign-in the default. The admin may
still *offer* a credential per CLI (§5.4), but a user never depends on it.

### 5.1 A user's own logins

- **Where:** exactly where they are today: `<state_dir>/agent-auth/`, kept by
  `agent_auth` in the user's own daemon and copied into each of that user's
  scope homes. One login per CLI per user, shared across that user's scopes.
  Nothing new is built, and nothing crosses users: the store sits in a `0700`
  home under the user's uid.
- **Signing in:** a sign-in tab running the CLI's login command in the user's
  own daemon. This is Mobile's sign-in tab (`mobile_control/sign_in.rs`, QA
  31bk) unchanged, so it works from the browser and from the phone.
  Device-code flows need nothing more.
- **The `localhost` OAuth callback.** For CLIs whose redirect targets
  `localhost`, the browser lands on the *laptop's* localhost, and the
  `sign-in-callback` relay forwards the redirect to the server's loopback.
  Today the relay fetches any loopback port ≥ 1024 (`sign_in.rs:57-60`). On a
  multi-user host that would let one user poke another user's listeners, so
  it forwards only when both hold:
  - the target port's listener is owned by the **caller's uid** (the uid
    column of `/proc/net/tcp{,6}`);
  - a sign-in tab of that user is open.
- **Account guard, refresh write-back, sign-out:** unchanged from the desktop,
  because each user's `agent_auth` is exactly the single-user case it was
  built for.
- **Installing CLIs.** A user can install a CLI for themselves, as today, into
  `<state_dir>/agents/install/` (`agent_install.rs:1-13`). The admin can also
  install a CLI once for everyone into the **server-wide install root**,
  `/opt/tabtivity/agents/`, owned by `tabtivity-cli`:
  - the install runs as `tabtivity-cli` through a helper verb, never as root,
    because vendor install scripts are code;
  - the root is readable by every user and bound read-only into every fence;
  - its version pins (`services::agent_versions`) are server-wide.

  When both exist, a user's own install wins, as a per-user override.
- **Rate limits and terms** are each user's own. The provider sees each user
  as themselves, and one heavy user no longer uses up anyone else's quota.

### 5.2 Choosing a credential, per CLI

For each CLI, a user's agents run on exactly **one** active credential:
- **their own login** (the default), or
- **the admin-provided credential**, if the admin offers one for that CLI and
  the user picks it.

The choice is per user and per CLI. It is never both, so the CLI is never
left to pick between an environment key and a login file. Switching is a
setting in the user's Manage CLIs, not an admin action.

### 5.3 What it costs

- **A user's own login is readable by that user's agents**, as on the desktop
  today. A prompt-injected agent can read its own user's credential file, and
  the fence can't prevent that because it is the CLI's own file. The damage
  stays within that user's account.
- **Every user needs their own subscription or key** for each CLI they use.
  That is the price of the default, and the reason §5.4 exists.

### 5.4 Admin-provided credentials (optional)

The admin can offer a credential per CLI in an admin-only **Agent
credentials** panel. Users opt in per CLI (§5.2).

- **API key, delivered directly (P3b).**
  - **Storage:** `/var/lib/tabtivity-auth/<cli-id>/api-key`, mode `0600`, owned
    by `tabtivity-auth`. It is never written to `settings.json`, which already
    holds one plaintext token too many (`git_token`).
  - **Delivery:** the daemon passes the key the way the CLI takes one: an
    environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or the
    CLI's own key file. The variable for each CLI goes into a new
    `api_key_env` column in the agent registry in `commands::agents`, and the
    `agent_bin` shim sets it the same way for a CLI typed into a shell tab.
  - **Exposure:** every agent of an opted-in user can read the key, and
    direct mode has no per-user budget.
- **API key through a broker (P5).** `tabtivity-keybroker`, running as
  `tabtivity-auth`, holds the key. Agents get a base URL pointing at the broker
  plus a **per-user broker token** (for Claude Code, `ANTHROPIC_BASE_URL`).
  The broker:
  - checks the token and adds the real key;
  - enforces a per-user budget;
  - records usage into that user's own stats.

  The key never enters a home, and one user's token is revocable without
  rotating the key. Fenced tabs share the host network namespace
  (`project_fence_abstract_sockets`), so a loopback port reaches the broker.
  That is also why the token is needed: any local process can reach a
  loopback port.
- **A shared consumer login (P5, at the admin's own risk).** Anthropic's
  Consumer Terms (§2) forbid sharing a login or making an account available
  to anyone else, and OpenAI's terms are similar. One suspension stops every
  user who opted in. The panel quotes those terms before the admin can enable
  this. If it is built, it keeps the review's hardening:
  - **Only a central keeper** (`tabtivity-auth-keeper`, `/run/tabtivity/auth.sock`,
    `SO_PEERCRED`) **refreshes**, proactively, in its scratch home, and pushes
    new generations to opted-in daemons.
  - **A user's refreshed file is never adopted.** The first draft's checks,
    the recorded account and `names_command`, authenticate nothing:
    - the account is a string the user writes (`agent_auth.rs:186-194`);
    - only codex and claude are checked (`:173-183`), and a `None` on either
      side adopts (`:241`);
    - `names_command` inspects only Pi (`:218-221`).
  - **Replicas carry the access token only**, wherever the CLI tolerates
    that.
  - It is enabled per CLI only after that CLI's row in Q2 is verified.
- **Signing out or rotating** an admin-provided credential withdraws it from
  every opted-in daemon. Whether a sign-out invalidates copies already taken
  is unverified (Q2).

---

## 6. Projects and sharing

### 6.1 Own projects

Creating, importing and cloning projects is today's flow inside the user's
daemon, landing under `~/tabtivity/projects/`. `projects.json`, `exec_trust`,
boxes and schedules are all per user and unchanged.

### 6.2 Sharing: a bare hub and a clone per member

The owner shares a project with user B as **viewer** or **editor**.

1. **The owner's project never moves.** The helper creates an empty bare repo
   `/srv/tabtivity/shared/<id>.git`, owned by `tabtivity-hub`. The hub's
   `config`, `hooks/` and `info/` are root-owned and read-only, and it has
   no hooks. The owner's daemon adds it as a remote and pushes, as the owner,
   through the hub service. (The first draft moved the tree. The real mover,
   `rename_project_dir` at `projects.rs:1541-1560`, renames only within one
   parent and fails with EXDEV across filesystems. It would also have broken
   every cwd-keyed Claude transcript.)
2. **Access is a named-user ACL on the hub, never a group.** Viewers and
   editors both get `u:B:r-X` (plus the default entry) to fetch. An ACL is
   checked on every access, so a grant or revoke takes effect at once, with
   no daemon restart. Supplementary groups, by contrast, are fixed at login
   and survive a revoke in every running process.
3. **Pushes go through `tabtivity-hub`**, a small service on a unix socket.
   It identifies the pusher by `SO_PEERCRED` and applies ref rules from the
   gateway database: editors may move `refs/heads/<user>/*`, and only the
   owner may move `main` (or whatever branch the owner protects). Viewers
   cannot push. A member never runs `receive-pack` as themselves against a
   writable hub, because a hook planted there would run as the next pusher.
4. **B's client lists "Shared with me"** from the gateway. Adding one clones
   the hub into `~B/tabtivity/projects/` through the ordinary add-project path
   (`find_project_conflict`, `check_project_site`). From then on it is an
   ordinary entry in **B's own** `projects.json`, with B's own tabs, trust
   decisions and agent homes, all in B's `state_dir`. The clone writes
   `.tabtivity/` into its `.git/info/exclude`, so session files (still written
   in-tree today: `.tabtivity/sessions/terminals.json`, `windows.json`,
   `state.json`, `terminal_service.rs:145`, `project_runtime.rs:162/274`)
   are never committed to the hub. A test pins that.
5. **Git's ownership check.** The hub is owned by another uid, so git
   (≥ 2.45.1) may refuse to fetch from it. Tabtivity passes `-c
   safe.directory=<exact hub path>` per call, never a global `*`. That is
   safe only because the hub's config and hooks cannot be written by any
   member (step 1). The exact scope of the check needs a test.

**Refused in v1:** sharing a remote, VM or container project. Lockstep's
`resolve`, `git clean` and checkout-follow, byte-sync and worker sync all
assume one human, as the sync plan's §6.1-6.2 already required.

### 6.3 Editing together

- B commits on `B/main` in B's clone and pushes it through the hub. The
  owner, or any member, fetches and merges or rebases in their own clone.
  Tabtivity reports divergence and does not resolve it (inheriting "no merge
  UI").
- An agent B starts in the shared project runs in **B's clone**, as B, in
  B's fence, on B's own login (§5). B's `.git` is B's alone, so nothing
  another member writes can become a hook or config in it.
- **The fence hides other shared projects.** The fence mounts `/` read-only,
  so without a change every hub B can read would be readable from every one
  of B's scopes. A co-member of project X could then steer B's agent into
  leaking project Y, which B shares with C. The fence puts a tmpfs over
  `/srv/tabtivity/shared` and binds back, read-only, only the hub of the
  scope's own project. A test pins it.
- **Pushes from a fenced agent** can't reach `tabtivity-hub`'s socket, because
  the fence has a private `/run`. They go through a Tabtivity-side proxy of
  the same shape as `tabtivity-git`'s `git_push`.
- **Later options (P5):** pair mode (one shared tree, for people who accept
  the hazards) and worktrees inside a shared tree. Both need the in-tree
  session files moved into `state_dir` first. Neither is ever the default.

### 6.4 Presence and visibility

- Each daemon reports `{project, since}` to the gateway on open and close.
  The gateway attributes it to the socket's peer uid and fans it out to that
  project's members only. A member-count chip goes on the project pill, as
  the sync plan §6.4 designs it.
- Busy state (`hostBusy`, the tmux Sessions view) gains a "whose" label.
  Members **cannot** attach to each other's tmux sessions. The sessions
  belong to another uid's tmux server, so the socket is unreachable anyway.
  The kernel enforces that, not a check Tabtivity has to remember.

### 6.5 The gates, rewritten

The sync plan §9 gated writable sharing on hooks, agent-surface review and
containers. This plan keeps the intent, but the mechanics change. All three
gates below must be closed before **editor** shares ship; viewer shares can
ship first.

1. **Hooks and repo config.** Tabtivity's own git already pins `core.hooksPath=`
   on every call that isn't trust-gated (`git.rs:95-111, 2427-2435`, #862).
   With per-member clones, no member can write another's `.git`, and the hub
   runs no hooks. What is left:
   - **`hooked_git_command_in` (the exec_trust-gated Commit/Push hooks) is
     refused in clones of shared projects**, because hook scripts can arrive
     by merge (a committed `.githooks/` plus a README telling you to point
     `core.hooksPath` at it).
   - `sanitize_repo_git_config` (`git.rs:292-306, 425-429`) is best-effort
     today (`let _ =`). For shared clones it **fails closed** when a
     denylisted key survives the strip.
2. **Review of the agent-facing surface.** Changes by *another member* to
   agent-facing files are shown for B's review **at merge time** into B's
   branch, before B's next agent spawn reads them. The review covers
   `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/**` (including
   `settings.json` hooks), `.codex/**`, `.gemini/**`, `.cursor/**`,
   `.mcp.json` and `.envrc`. Nothing implements this today; it is P4b work.
   Per-author trust is the leaning answer to how often the review appears
   (sync plan **Q9**).
3. **`exec_trust` never crosses users, and a merge re-asks.** A's trust for
   a `latexmkrc` or a project prettier is A's; B's daemon asks B. This holds
   by construction, because trust lives in `<state_dir>/exec_trust.json`, and
   a test pins it. A merge that changes a trust-gated file must re-ask.
   Verify that approvals are bound to content, given the check-to-use window
   `exec_trust.rs:22-25` documents.

**Why no container gate.** The sync plan required containers for writable
shares because every member's work ran on their own machine, under their own
account, with the shared tree live on disk. Here each member works in a
private clone under a separate uid, and the fence confines agents per scope.
A co-member can reach you only through content you merge, which gates 2 and 3
cover. Rootless containers remain an option (P5).

### 6.6 Revoking and deleting

- **Revoke:** the helper removes B's named-user ACL entry on the hub, and the
  gateway drops B's ref rules. Both take effect on the next access, with no
  cooperation from B's daemon. **B keeps their clone**, which is a copy by
  design, and the share dialog says so. B's `projects.json` entry turns
  into a greyed "no longer shared" row, never a silent delete.
- **Delete:** owner only. The hub goes to a holding area (`paths.rs`
  disposal) for the retention window, and members see "deleted by owner".
  The owner's own project is untouched.

### 6.7 Mail, calendar and todo

**Decisions (user, 2026-09-29):** every user has mail, calendar and todo on
the server. **Mail is always private** to its user, with no sharing of any
kind. A user can **open a calendar, or a todo list, to other users**. All
three features can be **switched off**: by the admin for the whole server,
and by each user for themselves.

**Private by default, as today.**
- `<state_dir>/calendar.json` holds the user's calendars, their events and
  tasks (each task belongs to a calendar through `calendar_id`) and the board
  columns.
- `<state_dir>/mail/` holds the store and the accounts, never inside a
  project (`commands/mail.rs:92-94`). CalDAV accounts are also per user.
- All of it sits in a `0700` home under the user's uid, and the fence hides it
  from agents (`agent_fence.rs:1170`).
- Sharing a *project* never carries any of it. A task or event that refers
  to a shared project stays in its maker's calendar.

**Opening a calendar or a todo list to others.**
- **What is shared.** An owner shares one calendar at a time, as its
  **events**, its **tasks** (that calendar's todo list), or both, with named
  users as **viewer** or **editor**. A shared todo list brings its own board
  columns, because a task's `column` must mean the same thing to everyone.
  Today columns are one set per user (`task_columns`).
- **Where it lives.** Shared calendars do not live in any user's home. They
  move into **`tabtivity-calendar`**, a small service running as its own user
  `tabtivity-cal`, with its store in `/var/lib/tabtivity-calendar/` (SQLite, WAL)
  and a socket `/run/tabtivity/calendar.sock`. It is the calendar counterpart of
  `tabtivity-hub` (§6.2):
  - it identifies each caller's uid by `SO_PEERCRED`;
  - it checks that uid's role for the calendar in its own ACL table;
  - it applies per-operation changes with a revision number
    (compare-and-swap, as in §3.4 and #171);
  - it pushes change events to the daemons subscribed to that calendar.

  So a user's request still never reaches another user's daemon, and the
  authorization for shared calendar data lives in one small service.
- **Sharing is a move.** Sharing a calendar for the first time moves it from
  the owner's `calendar.json` into the service, after the owner confirms.
  Stopping every share offers to move it back. Private calendars never touch
  the service.
- **What never crosses a share:**
  - a task's **mail links** (`TaskMailLink`), because mail is private;
  - its **file links** (`TaskFileLink`), which name the owner's paths;
  - **alarm state**, which is per viewer: each user's own alarms, snoozes
    and dismissals stay in their own daemon.

  The service strips links on the way in, and each daemon fires its own
  alarms.
- **Content from others is untrusted text.** It is rendered as plain text,
  never HTML, and the service enforces size limits per field and per
  calendar.
- **Agents see shared calendars read-only.** A prompt-injected agent of one
  member must not rewrite everyone's calendar. The fence hides the service
  socket (private `/run`), and agent-facing calendar tools reach shared
  calendars only through the user's daemon, read-only in v1.
- **CalDAV-synced calendars can't be shared in v1.** Their truth is on the
  CalDAV server, so share them there.
- **Revoke** removes the ACL row, and the next read fails. The revoked user's
  daemon drops its cached copy. Copies or exports already made stay, and the
  share dialog says so.

**Switching features off.**
- **Admin, server-wide:** three switches, for mail, calendar and todo, plus
  one for calendar/todo sharing. They live in the gateway database and reach
  every daemon through `server_capabilities`.
- **User, for themselves:** the same three switches in their own settings,
  within what the admin allows.
- **Off means:**
  - the feature's commands are refused with a named reason, and its controls
    are hidden (§3.3);
  - its timers don't run: no alarms, no CalDAV sync, no mail fetch, no push;
  - for mail, no store key is ever set up (§6.8).
- **Data is never deleted by a switch.** Switching back on finds everything
  where it was.
- **Existing shares are unaffected.** The user's own shares stay until they
  stop them; the switch dialog lists them and offers that. Incoming shares
  are hidden.
- **Where it is enforced.** Tabtivity enforces the admin's switches where it
  holds the authority: the gateway routes, `tabtivity-calendar`, and push.
  Inside a user's own daemon a switch is policy only, since a user with a
  shell can run their own mail client regardless.

**The gateway never holds any of it in readable form:**
- Presence, audit rows and the admin's per-user status carry no counts,
  subjects, titles or times. The audit log records that a calendar was
  shared or revoked, but not its content.
- Web Push payloads (alarms, new mail) are encrypted in the user's daemon to
  the device's push key (RFC 8291), so the gateway forwards only ciphertext.
  At the `host.rs` split, push encryption stays with the daemon and only
  delivery moves.
- A test greps the gateway database and the audit log for a planted subject
  and title.

**Timers** (alarms, CalDAV sync, mail fetch) run in the user's own daemon
(§3.4), so they work with no client connected.

### 6.8 Secrets on the server: the mail key and saved passwords (Q5, decided)

On the desktop, mail's at-rest key comes from the OS keychain (`file_keys()`
attempts a silent unlock), and saved passwords go to the keychain on opt-in.
A server daemon has no Secret Service session. The decision below (Q5,
delegated by the user on 2026-09-29) optimises for **safety first, then
availability**.

**Options weighed:**

| Option | Backup/disk theft | Admin at rest | A user's agent | Mail after restart/reboot |
|---|---|---|---|---|
| Prompt every time | safe | safe | safe | never runs in the background, so server mail is pointless |
| Key file in `state_dir` | **exposed** | exposed | exposed if the fence slips | always |
| TPM / `systemd-creds` sealed | safe off-box | **exposed** (root unseals) | safe | always |
| Passphrase-derived | safe | safe until typed | safe | after typing, which adds a password the web login deliberately doesn't have |
| **Device-released key, held in the kernel keyring** | **safe** | **safe at rest** | **safe** (fence blocks `keyctl`) | through daemon restarts; after a reboot, from the next device connect |

**Chosen: a device-released key.**

- **One master key K per user** seals the mail store, as `mail_crypt.rs`
  does today, and also a **sealed credential store** in `state_dir`. That
  store holds opt-in saved passwords: IMAP, SMTP, CalDAV, SSH. The standing
  rule stays: nothing is saved unless the user opts in, and the opt-in goes
  here instead of the keychain.
- **K is wrapped once per paired device, and never stored in the clear.**
  - At pairing, each device also makes a non-extractable **ECDH P-256** key
    in IndexedDB, next to its signing key; the ECDSA key can only sign. The
    daemon records its public half.
  - While K is unlocked, the daemon wraps K for every device: it takes an
    ephemeral ECDH key X, derives a key with HKDF from ECDH(X, device), and
    encrypts K under it with AES-GCM. It stores the wrap and X's public key,
    and discards X's private key.
- **Unlocking needs both halves.** On connect, the daemon sends the device X's
  public key. The device computes the shared secret inside WebCrypto and
  returns it, encrypted to a per-connection key signed by the daemon's
  identity key, which the device pinned at pairing. The TLS-terminating
  gateway therefore sees only ciphertext.
  - A disk image or backup holds only wraps, which are useless without a
    device.
  - A stolen device key is useless without the server's wrap.
- **K lives in memory only.**
  - The daemon keeps K in the kernel's **per-user persistent keyring**
    (`KEYCTL_GET_PERSISTENT`), never on disk. K therefore survives daemon
    restarts, including immediate security restarts (§8), but not a reboot.
  - The daemon sets `PR_SET_DUMPABLE=0`, and deployment requires
    `kernel.yama.ptrace_scope ≥ 1`, so other same-uid processes can't read
    its memory.
  - Fenced agents can't reach the keyring, because the fence's seccomp filter
    blocks `keyctl` (committed `f55f070f`, **never verified live**). A P3 exit
    test proves it.
- **Locked state.** After a reboot, mail and saved passwords stay locked
  until any of the user's devices connects. The UI and one push notification
  say "mail locked since reboot; open Tabtivity on any device". Calendar and
  todo hold no secrets and keep working.
- **Revoking a device** deletes its wrap.
- **Recovery.** At mail setup the user gets a one-time **recovery code**, a
  random key under which one more wrap of K is kept. It is shown once and
  never stored by Tabtivity. If every device and the code are lost, the sealed
  store is lost. Mail itself is refetched from IMAP, so what is lost is the
  saved passwords and local-only data (filters, drafts), and the setup
  dialog says so.
- **Residual, stated at enrolment.** Root can read a live daemon's memory and
  the kernel keyring while K is unlocked. The admin is trusted for live data
  (§4.4); what this protects is data at rest, backups, and the user's own
  agents.

---

## 7. Clients

### 7.1 Browser (the desktop client, v1)

`vite build --mode web` produces the same bundle with the `main-web.tsx`
entry, served by the gateway.

| Desktop feature | In the browser |
|---|---|
| Tabs, terminals, agents, viewers, git, search, TeX | identical: `core` commands |
| OS-dependent behaviour (tmux, paths, install commands) | follows `HOST_OS` from the server, never the browser's OS (§1.2) |
| Popout windows | browser windows (§3.5) |
| Native print | `window.print()` of the viewer; PDF export through the server |
| Clipboard | `navigator.clipboard` (needs a secure context, which HTTPS provides) |
| Open outside / xdg-open | download, or a new tab on the sandboxed user-content origin (§3.5) |
| File pickers | the server-side picker; "upload from this computer" as a separate button |
| Drag a file out to the OS | download |
| Machine sensors (CPU/GPU/net in the header) | the **server's** figures, labelled as the server, per the "never render a missing reading as zero" rule. The laptop's own figures are gone, not zeroed. |
| Global shortcuts | Browsers reserve Ctrl+T, Ctrl+W and Ctrl+N, so the chords that collide get web alternatives in `lib/shortcuts`, keyed by `CLIENT_OS`. Installing the app as a PWA helps only partly. **This is the main argument for 7.2.** |
| WebKitGTK workarounds (scrollbars, box-shadow, DMABUF) | harmless in Chromium and Firefox; nothing removed |

### 7.2 Tabtivity shell (later, P5)

The existing desktop binary gets a **Connect to server** mode. It loads the
same web bundle from the gateway and keeps every `client` command local:
native clipboard, print, notifications, popouts, all shortcuts, and
open-outside after a download. Every `core` command goes to the server. It is
the same Tauri app with a second transport, not a new product.

### 7.3 Phone

The PWA does not change. The gateway takes over the sidecar's
authentication and routing, keyed by user, and the daemon answers the data
routes. Each `DesktopRequest` is answered by the daemon's `workspace` service
(§3.4) instead of a window. Web Push moves into the gateway. **The same
view:** the phone and the desktop render the same daemon state, so a tab
renamed on one is renamed on the other within one patch event. Opening a
terminal on the phone takes that tab over from any other viewer (§3.5).

---

## 8. Operations

- **Resource limits:** `tabtivity-users.slice` caps the whole population. Each
  per-user slice, `tabtivity-user-<uid>.slice`, sets `MemoryMax`, `CPUWeight`
  and `TasksMax` and holds both the daemon and the tmux unit, so every agent
  counts. One user's runaway build cannot starve the others.
- **Deployment prerequisites, checked at install and in P3's exit:**
  - Unprivileged user namespaces must work for bubblewrap. Ubuntu's AppArmor
    restriction, or unit hardening such as `RestrictNamespaces=` and
    `ProtectSystem=`, would make every agent fail closed.
  - `/proc` is mounted `hidepid=invisible`.
  - `kernel.yama.ptrace_scope` ≥ 1, and the kernel persistent keyring is
    available (`CONFIG_PERSISTENT_KEYRINGS`) (§6.8).
  - Units run with `PrivateTmp=`.
  - Every home is `0700`.
- **Disk:** filesystem quotas per user, and a quota for `/srv/tabtivity/shared`.
  The existing big-folder census (`big_folders`, `duscan`) runs per user
  inside the daemon, never across `/srv`.
- **GPU:** `gpustat` shows the server's GPUs to everyone. Allocating them
  (per-user `CUDA_VISIBLE_DEVICES`) is out of v1 scope; an HPC-style
  scheduler would be the real answer here.
- **Upgrades:**
  - The gateway and daemons are one release, and the gateway serves the web
    bundle, so a browser always loads the matching client.
  - The gateway still speaks the N-1 daemon protocol (§3.5). Because the
    agents live in the tmux unit, a daemon can restart at any time without
    killing them. Feature releases restart daemons at the next idle.
    **Security releases restart them at once.**
  - The tmux unit restarts only when the user's sessions end.
  - The phone PWA already copes with version skew.
- **Backups:**
  - `/srv/tabtivity/shared`, homes, `/var/lib/tabtivity-gateway`,
    **`/var/lib/tabtivity-auth`** and **`/var/lib/tabtivity-calendar`**.
  - A backup can't open anyone's mail or saved passwords: their key lives
    only in memory and on the users' devices (§6.8).
  - A restore must keep uids, gids and ACLs.
  - `state_dir`'s agent homes and the auth store contain credentials, so a
    backup is a secret.
- **Audit log** (gateway): `(time, user, device, verb, resource, result)`
  for logins, pairings, shares, revocations and admin actions. **Not** per
  command, **not** terminal content, and no IP addresses. Retention is
  bounded, and access is symmetric: each user sees their own entries, and an
  owner sees their project's. This is the sync plan's §4.4, unchanged.
- **Observability:** each daemon writes to the journal as its unit. The
  gateway exposes a `/healthz` (it already exists) and, for admins only, a
  per-user daemon status with no content.

### 8.1 Install and packaging

- **Build targets:** `tabtivity-gateway`, `tabtivity-serverd`, `tabtivity-admin-helper`,
  `tabtivity-hub`, `tabtivity-calendar` and `tabtivity-auth-keeper`, all Linux x86_64 and aarch64, plus
  the web bundle. Until P3 the single-user server is the existing `tabtivity`
  binary in `--mobile-host` mode.
- **What ships:** a `.deb`/`.rpm`, or a tarball plus an install script. It
  carries:
  - the systemd units and slices;
  - the polkit rule for the helper;
  - the service users (`tabtivity-gw`, `tabtivity-hub`, `tabtivity-cal`,
    `tabtivity-auth`, `tabtivity-cli`);
  - `/opt/tabtivity/agents`;
  - the web bundle.
- **Signing:** the server artifacts go through the same release-signing
  lane as the desktop (`docs/context/release_signing.md`).
- **Migrating an existing desktop user** to a server goes one project at a
  time through `project_transfer` (`.tabtivityproj`); agent logins are redone
  on the server (Q13).

---

## 9. Invariants: which hold, which change

| AGENTS.md invariant | On the server |
|---|---|
| Project folder is attacker-controlled; session state in `<state_dir>/sessions/` | **Holds, and matters more:** co-members' commits arrive by merge. Leftover in-tree session files are kept out of commits (§6.2 step 4). |
| Passwords never persisted by default; opt-in goes to the OS keychain | **Holds, changed in where opt-in goes:** a daemon has no desktop Secret Service session, so opt-in saving goes to a per-user sealed store whose key the user's devices release and which is held only in memory (§6.8, Q5 decided). Nothing is saved without the opt-in. |
| Remote/VPN auto-connect never prompts | OpenVPN is `admin`. Per-user remote projects work by SSH from the daemon; auto-connect needs keys (an `ssh-agent` per daemon), never a stored password. |
| Hardened git, `exec_trust` | Hold; shared clones refuse hooked verbs, and config sanitizing fails closed (§6.5). |
| `agent_fence` fails closed; the Host session is the one unfenced agent | Holds, provided user namespaces work (§8). The fence also hides other shared hubs (§6.3). The Host session is offered (**Q6**): under a per-user uid it equals the user's own SSH login, with no sudo. |
| Agents live only in Tabtivity (agent homes, `agent_auth`, `agent_global`) | Holds per user, unchanged: each user signs in to their own CLIs (§5). Config, skills, hooks and MCP entries stay per user and per scope. CLI binaries come from the user's own install or the server-wide root. |
| `services/` stays `AppHandle`-free | **Not true today:** seven modules and `terminal/mod.rs` break it. P1 fixes them first (§3.2). |
| `mobile_control`: raw ids/paths never cross the browser API | Holds for the phone API. **Relaxed** for the web desktop client toward its own user, on a separate route prefix (§4.3). Never crosses users. |
| Terminal kill reaps the whole subtree | Holds. Stopping the user's slice reaps everything, and a daemon restart does not touch agents (§3.1). |
| Remoteness explicit; `services::remote` source of truth | Holds; "remote" now means remote *from the server*. Remote projects can't be shared in v1 (§6.2). |
| Containers: one per local project via `services::sandbox` | `admin`/off in v1: the Docker socket is root on the host. Rootless Podman per user is **P5**. |
| `hpc_hosts`, `careful_hosts` | Hold, per user. |
| Permission mode is the CLI's own; Tabtivity injects none | Holds. Neither a user's login nor an admin-provided credential carries a mode. |
| Gate remote probes on connected; gate hidden panes | Hold, plus the global server-link gate and poller pause (§3.5). |
| Never animate blurred `box-shadow`; WebKitGTK paths | Irrelevant in other browsers; kept for the Tauri shell. |
| All strings through `i18n.ts`; `UntestedTag` on new surfaces | Hold for every new surface in this plan. |
| Tabtivity never edits another app's paths or config | The admin helper edits **system** config (users, ACLs, units) on a server Tabtivity is administering. That needs an explicit, documented exception, as sync plan **Q2** found for Radicale. |

---

## 10. Phases

Each phase ships on its own, and each is worth having even if the next never
comes.

**P0: decisions and the command table.**
- ~~Answer §12 Q1, Q3 and Q4.~~ Answered 2026-09-29; all three confirm the
  shape this plan already assumes (§14).
- Write the command class table and its completeness test (§3.3). This is
  cheap, and it forces the per-command conversation early.
- The desktop prerequisites that used to sit here (#171, #172, the sidecar
  serving persisted-state kinds with the window closed) are H0 of
  [`headless_owner_plan.md`](headless_owner_plan.md).

**P1: one headless owner.** The riskiest phase, done first.
- [`headless_owner_plan.md`](headless_owner_plan.md) H0–H3, on the desktop.
  Its exit is this phase's exit.
- In parallel: start the crate extraction (§3.2). Fix the seven services and
  `terminal/mod.rs` first, then convert one `commands/*.rs` file at a time,
  keeping all five gates green after each.

**P2: single-user server, "my box, thin clients".**
- The sidecar grows a `core` dispatcher and serves the web bundle. There is
  no gateway/daemon split, no admin helper and no unix RPC yet. Commands not
  yet dispatchable are hidden through `server_capabilities`.
- The web entry and the `__TAURI_INTERNALS__` shim, the `HOST_OS`/
  `CLIENT_OS` split and the 25-file audit, the server-side file picker, and
  the transport of §3.5: binary frames, per-client size, offset resume,
  bounded queues and the poller pause.
- The user-content origin for ticketed files.
- **Localhost first.** Nothing is reachable beyond localhost until the CSP
  review and the §11 security review are done.
- *Exit, live:*
  - open a project in a browser, start an agent, close the laptop, continue
    from the phone, reopen the laptop and find both views identical;
  - two browsers open at once lose no tab;
  - keystroke latency is inside the §3.5 budget.
- *This alone answers "operations run on the server" for one person.*

**P3: multi-user.**
- Finish the crate split. Split `host.rs` into the gateway (auth, router,
  push) and the daemon (data paths), and build `tabtivity-serverd` on
  `CoreCtx`.
- The admin helper and its hard rules, the per-user slices and units, the
  tmux unit, `0700` homes, the invite flow, per-user device keys verified by
  the daemon, and the audit log.
- The deployment prerequisite checks (§8), the server-wide CLI install root,
  and the host-channel inventory (§4.4).
- Per-user sign-in (§5.1): sign-in tabs from browser and phone, and the
  callback relay restricted to the caller's own listeners.
- Per-user mail, calendar and todo (§6.7), with the admin's and users'
  opt-out switches. The device-released secrets key (§6.8): the per-device
  ECDH key at pairing, wraps, the kernel persistent keyring,
  `PR_SET_DUMPABLE`, the recovery code, and sealed opt-in passwords.
- *Exit:* two users on one server. Each user's attempt at the other's paths,
  sockets, tmux, loopback listeners and `/proc` fails, and a test runs that
  attempt, including each other's calendar, tasks and mail. Each user signs
  in to a CLI from the phone and runs an agent on their own login. A daemon
  restart leaves both users' agents running, and mail stays unlocked across
  it. A fenced tab can't read the keyring entry, and a backup of the home
  can't open the mail store.

**P3b: admin-provided API keys (optional).**
- The admin-only Agent credentials panel, direct API-key delivery, and the
  per-user, per-CLI choice between one's own login and the admin's key
  (§5.2, §5.4).
- *Exit:* one user on their own login and one on the admin's key, for the
  same CLI at once, with neither affecting the other.

**P4: sharing.**
- *P4a, viewer shares:* hub creation, named-user ACLs, clone-to-add, "Shared
  with me", presence, revocation, the fence tmpfs over `/srv/tabtivity/shared`,
  the `safe.directory` pin, and session files kept out of commits. Remote,
  VM and container projects are refused.
- *P4b, editor shares, **gated on §6.5**:* `tabtivity-hub` with ref rules, the
  agent-facing surface review at merge time, hooked verbs refused in
  shared clones, sanitizing that fails closed, and trust re-asked on merge.
- *P4c, calendar and todo sharing* (independent of P4a/b; needs only P3):
  `tabtivity-calendar`, the move-on-first-share, viewer/editor roles, link
  stripping, per-viewer alarms, read-only agent access, and the sharing
  switch.
  - *Exit:* A opens a calendar's events to B as viewer and its todo list to
    C as editor. B can't write, C's edit reaches A within one patch, a task's
    mail link never reaches C, and revoking stops B's next read.

**P5: options, each independent.**
- The API-key broker with per-user budgets (§5.4).
- A shared consumer login, at the admin's own risk, with the §5.4 hardening,
  enabled per CLI after Q2.
- OIDC login.
- The Tauri shell's Connect mode.
- Rootless Podman per user.
- Pair mode and in-tree worktrees for shared projects.

i18n and `UntestedTag` rows land inside each phase, never after it.

---

## 11. Verification

- **Gates:** all five AGENTS.md gates stay at zero warnings through P1 on
  every converted file. That is how an extraction touching 211 coupled
  commands stays reviewable.
- **Owner tests (P1):** [`headless_owner_plan.md`](headless_owner_plan.md)
  §4.
- **Protocol tests:**
  - the shim against a fake daemon: every `__TAURI_INTERNALS__` member,
    event subscribe and unsubscribe, rejection on disconnect, resume by
    offset;
  - the command table's completeness test.
- **Isolation tests (P3):** run on the CI runner itself. ubuntu-24.04
  runners have sudo (`ci-cd.yml:123`), so the job can create two Unix users.
  It must also lift the runner's AppArmor restriction on unprivileged user
  namespaces (`sudo sysctl`), or the fence tests prove nothing. A container
  would not work here: it can't run bubblewrap either. Assert that user A's
  gateway session can't do any of the following against user B:
  - read, list, attach to or signal B's files, sessions or processes;
  - reach B's daemon socket, loopback listeners or `/proc`.

  Assert on the error, not on the absence of output: the lockstep matrix
  taught that a no-op reporting success is the likely failure.
- **Sharing tests (P4):**
  - a viewer can't push;
  - an editor can't move another member's refs or `main`;
  - revoking stops the next fetch;
  - the hub's config and hooks can't be written by any member;
  - `.tabtivity/` never reaches a commit;
  - one scope's fence can't read another project's hub.
- **Calendar/todo sharing tests (P4c):**
  - a non-member's request to `tabtivity-calendar` is refused, and so is a
    viewer's write;
  - two editors' concurrent edits converge by revision;
  - mail and file links never reach the service;
  - an agent tool can't write a shared calendar;
  - an admin or user switch set to off refuses the feature's commands and
    stops its timers without touching its data.
- **Secrets tests (P3):**
  - the mail store opens only after a device releases the key;
  - the key survives a daemon restart but not a keyring flush;
  - a fenced tab's `keyctl` fails;
  - a copy of the home plus the gateway database can't open the store;
  - the recovery code opens it.
- **Security review before any P2 exposure beyond localhost:**
  - WS Origin checks, cookie flags and the CSP;
  - file-ticket path traversal and the user-content origin;
  - rate limits;
  - before P3, the admin helper's argument validation and the hub's ref
    rules. The helper gets a review of its own, since it is the only root
    code.
- **Live QA:** one row per phase exit criterion in the QA Runner. The
  per-platform ✅/❌ pairs apply to the *client* platforms: Linux, Windows and
  macOS browsers, and the phone.

---

## 12. Open questions for a human

**Q1. Who are the users?** *Answered (user, 2026-09-29):* a few trusted
colleagues on a machine the admin runs, and the admin is one person. Login is
invite codes plus device keys (§4.1), OIDC stays P5, and quotas are the
per-user slices and filesystem quotas of §8, not a hard multi-tenant regime.

**Q2. Admin-provided credentials, per CLI.** *Answered (user, 2026-09-29):*
both options stay: admin API keys (P3b) and the at-risk shared consumer login
(P5), each on top of the user's own login, the default (§5). What remains is
research, not a decision: each CLI's row below is verified before that
option is enabled for it (§5.4):
- *API keys (P3b):* which variable or file carries the key, and does the CLI
  accept a base-URL override (needed for the broker)?
- *A shared consumer login (P5):* does a refresh rotate the refresh token? Do
  two holders refreshing at once invalidate each other? Does the CLI run on a
  replica it can't write back, or on an access token alone? How is a leaked
  token revoked?

**Q3. Editing together.** *Answered (user, 2026-09-29):* per-member clones
through the `tabtivity-hub` bare repo (§6). A shared tree with worktrees stays a
P5 option and is never the default.

**Q4. The tab set across a user's clients.** *Answered (user, 2026-09-29):*
the tab set is shared, while pane layout, focus, scroll and terminal size are
per client (§3.4). Phone and desktop do not mirror each other's layout.

**Q5. Saved credentials on the server.** *Decided (delegated by the user,
2026-09-29):* a per-user key, wrapped per paired device, released by a
device's ECDH half on connect, and held only in the kernel's per-user
persistent keyring. It seals the mail store and the opt-in saved passwords,
and comes with a one-time recovery code (§6.8).

**Q6. The root console's Host session on the server.** *Answered (user,
2026-09-29):* allowed, under the user's own uid only. It equals the user's
own shell there, so it gains no reach; no sudo, and admin verbs stay with the
helper (§3.3).

**Q7. Mail and CalDAV on the server.** *Answered (user, 2026-09-29):* in
scope and per user. Mail is always private. The admin and each user can
switch mail, calendar and todo off (§6.7).

**Q8. TLS.** *Answered (user, 2026-09-29):* Tailscale Serve, as Mobile does
today. Nothing faces the public internet; colleagues reach the server through
the tailnet. ACME and a reverse proxy are not in scope.

**Q9. GPUs.** *Answered (user, 2026-09-29):* first come, first served, as
§8 has it. Per-user `CUDA_VISIBLE_DEVICES` waits until contention shows up.

**Q10. Group Z.** *Answered:* `todo/group-z-server.md` has been rewritten
for this plan. It keeps #169 (CalDAV live test, needed for Q7), #170 (generic
remote URL publishing), #171 (calendar compare-and-swap, P0) and #172
(`write_json_atomic` parent-directory fsync, P0).

**Q11. Provider terms and the default login.** *Answered (user,
2026-09-29):* each user signs in to their own CLIs, as the default. A shared
consumer login is an optional P5 item at the admin's own risk, and the terms
are quoted before it can be enabled (§5).

**Q12. Standalone and server side by side.** *Answered (user, 2026-09-29):*
side by side, as separate apps. The desktop app stays standalone for local
and offline projects, server projects open in the browser client, and both
can run at once. One window holding both waits for the P5 shell (§7.2).

**Q13. Migrating an existing user.** *Answered (user, 2026-09-29):* one
project at a time through `project_transfer` (`.tabtivityproj`); the user
chooses what moves, and agent logins are redone on the server. No
whole-`state_dir` import in v1.

**Q14. The sync plan's shared calendar and board.** *Answered (user,
2026-09-29):* a user can open a calendar or a todo list to other users, as
viewer or editor, through `tabtivity-calendar`. Mail is never shared (§6.7).

---

## 13. Non-goals

- **No shared terminals or agent sessions.** Sharing a project is not sharing
  an authority. A read-only "watch B's session" is a possible later idea, not
  v1.
- **No real-time co-editing** (CRDT/OT); the reasons are the sync plan's §14.
- **No request of one user ever reaches another user's daemon.**
- **No shared mail, ever.** Calendars and todo lists are private unless
  their owner opens one to named users (§6.7).
- **No mode Tabtivity chooses for an agent** (permission-mode invariant).
- **No Windows or macOS server.**
- **No self-signed-certificate override**, in the gateway as everywhere.
- **No team dashboards** of usage or time. Both stay per person.
- **The desktop app does not become server-dependent.** Standalone Tabtivity
  remains the default product.

---

## 14. Review log

**2026-09-29, three reviewers (security, architecture, scope), then one
discussion round.** All three agreed on every change below.

- **Live state first.** The frontend owns spawning, tmux naming, every timer,
  and a whole-array tab save, not just the 34 request kinds. Closing the
  window quits the app, so the owner is the Mobile sidecar. This became P1,
  "one headless owner", with group 0 ahead of the read-only ports (§1.3,
  §3.4, §10).
- **P2 grows out of the sidecar**, which is already a headless per-user
  `tabtivity_lib` process. The gateway/daemon split and the crate split move to
  P3. Nothing is exposed beyond localhost before the class table and the CSP
  review.
- **Sharing is a bare hub and per-member clones**, replacing the
  group-writable tree with worktrees. That draft allowed cross-user code
  execution through `.git/config`, filters and hooks, even for viewers. Its
  per-member worktrees could not be enforced, revoking group membership did
  not revoke access, and the move path failed across filesystems (§6).
- **Shared login:** the reviewers kept the first draft's decision, but
  found its upward write-back unauthenticated and raised provider terms
  (Q11). The user then replaced it (below).
- **Trust boundaries:**
  - the user controls their own daemon;
  - the daemon socket is `0660` with a peer-uid check;
  - the daemon verifies devices itself;
  - the helper takes ids, never paths, and links no system accounts;
  - the fence hides other shared hubs;
  - host-shared channels are added to the threat model;
  - user content is served from a sandboxed origin (§3.1, §4).
- **tmux** runs on `-L tabtivity` in its own unit inside a per-user slice. A
  daemon restart no longer kills agents, and security releases restart
  daemons at once (§3.1, §8).
- **Transport:** per-client terminal size, offset resume, bounded queues,
  binary bulk frames, periodic WebSocket re-checks, the poller pause, and the
  `HOST_OS`/`CLIENT_OS` split (§3.5).
- **Corrections:**
  - device keys are ECDSA P-256;
  - trust lives in `exec_trust.json`;
  - `services/` is not `AppHandle`-free, and 8 `Window` commands are `core`;
  - the command split is 388/57/211 of 658 registered;
  - host.rs has 49 routes;
  - the fsync is half done;
  - the worktree root is `.tabtivity/worktrees`;
  - CI can create users;
  - the units are system templates, with no linger;
  - Q10 is answered;
  - Q11–Q14 are added.
**2026-09-29, user decisions.**

- **Q11:** each user signs in to their own agent CLIs, as the default. §5 is
  rewritten around today's per-user `agent_auth`, and the sign-in relay is
  restricted to the caller's own listeners. Admin-provided API keys become
  optional (P3b), and the shared consumer login becomes an at-risk P5 option
  that keeps the review's hardening.
- **Q7/Q14:** mail, calendar and todo are on the server, per user. Mail is
  always private. A calendar or todo list can be opened to other users
  through a new `tabtivity-calendar` service (P4c). The admin and each user can
  switch each feature off (§6.7).
- **Q5 (delegated):** a device-released key, held only in the kernel
  keyring, seals mail and the opt-in saved passwords. It was chosen over a
  key file, TPM sealing and a passphrase for backup safety and protection
  from agents, while still surviving daemon restarts (§6.8).
- **Split (2026-09-29):** §1 decision 3's detail, §3.4's ownership table,
  protocol and migration order, P0's desktop items and the owner tests moved
  to [`headless_owner_plan.md`](headless_owner_plan.md), because all of it
  pays off on the desktop with no server. This file keeps the server delta.
- **Q1/Q3/Q4:** a small trusted group with one person as admin (invites and
  device keys, OIDC stays P5); per-member clones through the hub; a shared
  tab set with per-client layout. Each confirms what the plan already
  assumed, so no section changes beyond §12 and P0.
- **Q2/Q6/Q8/Q9/Q12/Q13:** both admin credential options stay, with Q2's
  per-CLI facts left as research before each is enabled; the Host session
  moves from `off` to `core` under the user's own uid (§3.3, §9); TLS is
  Tailscale Serve only; GPUs are first come, first served; standalone and
  server run side by side as separate apps; migration is per project via
  `.tabtivityproj` (§8).

- **Follow-ups outside this file, done 2026-09-29:**
  - `docs/tabtivity_remote_plan.md` is marked superseded;
  - `docs/mcp_control_plan.md` decision 2 gained a "revisit when P1 lands"
    note;
  - the summary line in `todo/group-z-server.md` now matches §5–§6.7.
