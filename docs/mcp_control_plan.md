# Tabtivity MCP Control Server — plan

*Plan only. Nothing here is implemented. Produced 2026-08-03.* The **root
console's MCP** (`docs/context/root_console.md`) is the shipped, HTTP,
write-capable surface — a different server with a different threat model; this
document is the *control* server that was not built.

The request: **an MCP server for Tabtivity**, so that an agent (Claude Code in a
terminal, or any MCP client) can drive the app itself — *open a new tab of
type X*, *open this file of this project in a new tab*, *make this project
active/inactive* — instead of only working inside a shell.

Not to be confused with [`tabtivity_hosted_plan.md`](tabtivity_hosted_plan.md):
that is a multi-user server running every user's work. This is a **local
control surface for the running desktop app**, and it deliberately builds as
little server as possible.

---

## 1. The shape, in one page

**A thin stdio bridge binary, a Unix socket into the running app, and tools
that execute through the exact store actions the UI itself uses.**

```
claude / any MCP client
   │  stdio (JSON-RPC, MCP)
   ▼
tabtivity-mcp  (bridge bin — dumb, stateless, no tool knowledge)
   │  one JSON line per request, token-authenticated
   ▼
<state_dir>/mcp/tabtivity.sock  (0700 dir; Windows: named pipe)
   │
Tauri backend: services/control_socket.rs + commands/mcp.rs
   │  emit "mcp://request" ──► McpBridgeHost (AppShell, mounted once)
   │  ◄── invoke("mcp_respond")     │ calls useTabsStore / useProjectsStore
   ▼
the same addTab / activateProject / FileDropContext.openTab the UI runs
```

Five decisions carry the design:

1. **No listening TCP port, ever.** The transport is a Unix domain socket in
   the state dir (`<state_dir>/mcp/`, 0700) plus a random per-project token
   (`<state_dir>/mcp/tokens/<project id>`, 0600 — §1.5) checked on every
   connection. Authentication
   is filesystem permissions — the same trust boundary every other state file
   already lives behind. A localhost HTTP MCP server would be reachable by any
   local process *and* by any browser page via `fetch` to `127.0.0.1`; the
   socket is reachable only by processes running as the user. On Windows the
   socket becomes a named pipe (`\\.\pipe\tabtivity-mcp-<user>`), default-ACL'd
   to the user, with the same token check on top.

2. **Tools execute through the frontend, via the UI's own code paths.** Tab
   state lives only in `stores/tabs.ts`; project activation runs through
   `stores/projects.ts` `activateProject`/`deactivateProject` (which own VPN
   prompts, container warm-up, SSH pool teardown). Re-implementing any of that
   backend-side would be a second implementation that drifts. So the backend
   is a *router*: it holds a pending-request table, emits `mcp://request`
   `{id, project, tool, args}` (the project resolved from the token, never
   from an argument), and a single `McpBridgeHost` (mounted once in
   `AppShell`, the `MailOverlayHost` pattern) dispatches to store actions and
   answers with `invoke("mcp_respond", {id, result})`. No window, or 10 s
   without an answer → the tool call fails with "Tabtivity window not
   responding", never hangs the client. The exception is `tabtivity_status`,
   whose source of truth is backend files (`projects.json`,
   `active_session.json`), answered without the round trip.

   *Revisit when the headless owner lands (noted 2026-09-29).*
   [`headless_owner_plan.md`](headless_owner_plan.md) moves the live
   model out of the window into one headless `workspace` owner, the Mobile
   sidecar. That covers the tab set, spawning, project activation and every
   timer. Because it is a *move*, not a second implementation, the drift
   argument above stops applying to each slice once that slice has moved.
   For a moved slice, tools call the owner's per-operation commands instead
   of going through `McpBridgeHost`, and they keep working with the window
   closed. Until a slice moves, this decision stands for it.

3. **The bridge is dumb and the tool list has one home.** `tabtivity-mcp` is
   invoked as `tabtivity-mcp --project <id>`, reads that project's token from
   the state dir (the id is an identifier, not a secret — the token file is
   the credential), speaks the small MCP stdio subset (`initialize`,
   `tools/list`, `tools/call`, `ping`) and forwards everything else
   verbatim. At `initialize` it asks the
   socket for the tool manifest (`describe`), so adding a tool is a
   backend-only change and a stale installed bridge can never advertise tools
   the running app doesn't have. It is a second `[[bin]]` in the
   `src-tauri` crate — same workspace, shares `services/`, shipped via the
   bundler's `externalBin`/resources. Hand-roll the JSON-RPC loop rather than
   pulling `rmcp`: the needed subset is four methods over stdio, and this repo
   already hand-rolls smaller-than-the-crate transports (`ollama.rs`).

4. **Default off, experimental.** A `mcp_server` flag in `Settings` via
   `lib/experimental.ts` (off for everyone, on in debug). Off means the socket
   listener never starts and the token file is absent — not "listening but
   refusing".

5. **Tokens are project-scoped from day one — there is no global token by
   default.** Registering a project mints `<state_dir>/mcp/tokens/<project id>`
   (0600, never in the project tree — in-project files are attacker-controlled,
   the #151 rule); every request's token resolves backend-side to
   `{project, tier}` and every tool acts inside that project. This removes the
   one genuinely *new* risk the feature would otherwise create: a
   prompt-injected agent working in project A driving project B — activating
   it (which can dial a VPN or an SSH host), opening its files on screen,
   spawning tabs in its scope. A steered agent that *also* has shell access
   can read another project's token file, but such an agent never needed MCP
   to cross projects; the scope holds exactly on the path MCP adds. An
   all-projects token is **not built in v1** — if it is ever wanted it is an
   explicit, separately-worded Settings action, not a default.

## 2. Threat model — who is calling, and with what authority

- **v1 callers are host processes running as the user.** Such a process
  already has full user authority (it can edit `settings.json`, spawn PTYs,
  read the keychain-adjacent files); the socket adds *convenience*, not
  *privilege*. That is why v1 tools need no per-call confirmation dialogs —
  a confirm would be theater against a caller that could do worse directly.

- **The interesting escalation is deferred, and stays deferred.** An agent
  tab inside a project container (`docs/context/docker_containers.md`) cannot
  reach the socket — the state dir is deliberately not mounted (the #151
  lesson: nothing the container can write may be read back as host intent).
  A remote-located agent tab can't reach it either. **v1 scope: host-run
  agents only.** Reaching the socket from a container means mounting that
  project's token plus a *tier* that withholds every PTY verb, and is its own
  future phase with its own review — `open_tab {kind:"shell"}` from inside a
  sandbox is a sandbox escape by construction. The `{project, tier}` token
  shape exists from Phase 0 precisely so that review starts from a scoping
  mechanism that already works, not from a retrofit.

- **Tool arguments are attacker-influenced.** The caller is an agent that
  reads project files, i.e. text an arbitrary repo authored can steer tool
  calls (the `sandbox_audit` posture applied to MCP). Consequences:
  - `open_file` takes `{project, path}` with `path` **project-relative**,
    canonicalized and confined to the project root backend-side (symlink- and
    `..`-safe, the `resolve_worktree_path` discipline). There is no
    open-arbitrary-absolute-path tool, matching the mail/browser path-free
    IPC precedent.
  - Tools that *type into* a PTY, run a command, or touch credentials are
    **not in this plan at all** — not even deferred. An agent that wants to
    run a command has a shell.
  - Strings coming back to the model (tab titles, project names) are data,
    not instructions; nothing here re-executes them.

- **Registration never touches another app's config** (the
  no-foreign-app-paths rule). Two offered paths, both user-executed:
  a one-click **install-via-new-tab** that opens a terminal with
  `claude mcp add tabtivity -- <path to tabtivity-mcp>` pasted and ready to run
  (the Ollama-models pattern), and a "write `.mcp.json` into this project"
  button — with the privacy caveat stated in the dialog: the entry embeds an
  absolute home path, and on a public repo that file must be gitignored
  (`scripts/privacy-check.sh` does not catch bare home paths).

## 3. Tools — v1 surface

Names are `snake_case`, schemas are plain JSON Schema in the manifest. **No
tool takes a `project` argument** — the token *is* the project (§1.5), so
there is nothing to resolve, nothing to mistype, and nothing for hostile repo
text to point elsewhere.

| Tool | Args | Does |
|------|------|------|
| `tabtivity_status` | — | App version, flag states, and the caller's project: id, name, kind (local/remote), whether it is active. Backend-answered; also the "is the app running" probe. Deliberately the *only* window onto the project list — other projects' names, paths and states are not this caller's to read. |
| `list_tabs` | — | The caller's scope only: tab key, kind, title, location, focused — from the live store (frontend round trip). |
| `list_tab_kinds` | — | The kinds `open_tab` may open *right now* — computed by the same gates the ➕ menu uses (`experimental`, `withdrawnTabKinds`, `browser_capabilities`), so the manifest and the menu cannot disagree. |
| `activate_project` | — | `useProjectsStore.activateProject` on the token's project. May legitimately end "waiting on user" (VPN password prompt) — reported as such, not as failure. |
| `deactivate_project` | — | `deactivateProject` on the token's project (closes SSH pool etc.). |
| `open_tab` | `{kind, location?}` | `addTabToScope` into the token's scope, with the kind's canonical `cmd` (`__tabtivity_*__`). v1 kinds: every non-PTY kind from `TabKind` that the gate allows. `shell` only behind `mcp_allow_pty_tabs`, **default off** (§6.1); `agent` tabs not offered at all — spawning an agent from an agent wants the group-O agent-spawn policy first. |
| `open_file` | `{path, viewer?}` | Confined resolve inside the token's project root (§2), then the `FileDropContext.openTab` path — so TeX roots dedupe into the workspace tab, viewers resolve exactly as a file-tree click does. |
| `focus_tab` | `{key}` | Focus + reveal, refused for a key outside the token's scope. |

`close_tab` is **not in v1** — it was the only destructive verb in the set
(a PTY tab holds a live process, and MCP has no undo), and nothing in the
stated use cases needs it. Revisit on demand.

Errors are structured (`{code, message}`) and actionable, because the caller
is a model that will retry.

## 4. Phases

**Phase 0 — seam.** `mcp_server` experimental flag; `services/control_socket.rs`
(listener lifecycle bound to the flag, per-project token mint/check resolving
to `{project, tier}`, line-framed JSON, request parse/validate as pure tested
functions); `commands/mcp.rs` (`mcp_respond`, pending table with oneshot
channels + 10 s timeout). Nothing user-visible; `tabtivity_status` answered
backend-side is the smoke test.

**Phase 1 — reads + frontend dispatcher.** `McpBridgeHost` in `AppShell`;
`list_tabs`, `list_tab_kinds`. The dispatcher's tool→action map is a plain
object, unit-tested in vitest with mocked stores; every frontend handler
receives the token's project and filters by it — scope enforcement is
checked on both sides of the IPC, not only in Rust.

**Phase 2 — actions.** `activate_project`, `deactivate_project`, `open_tab`
(non-PTY kinds; the `mcp_allow_pty_tabs` gate for `shell`, default off),
`open_file` (confinement first, with its own Rust tests: `..`, symlink out,
absolute path, remote project → mirror-vs-host decision), `focus_tab`.

**Phase 3 — the bridge.** `tabtivity-mcp` bin: stdio MCP subset ↔ socket,
manifest fetched at `initialize`, clean errors when the app is not running
("Tabtivity is not running — start it and retry", not a connect stack trace).
Bundler wiring for all three OSes; Windows named pipe.

**Phase 4 — registration UX + docs.** SettingsPanel row (enable flag, the two
install paths from §2 — each of which mints/rotates the *project's* token as
part of registering), `UntestedTag` on the new UI, i18n keys,
`docs/context/mcp_control.md` topic doc, `CLAUDE.md` file-map rows, backlog
group in `TODO.md` (new group; items continue from #209).

**Deferred, explicitly:** `agent`-tab spawning (needs group-O spawn policy);
container/remote reachability (PTY-less tier + its own review, §2); MCP
*resources* (exposing
project files as resources is a path-disclosure surface with no demonstrated
need); HTTP/SSE transport; a write-capable calendar/mail tool surface
(different threat model entirely — since shipped as the root console's MCP,
`docs/context/root_console.md`, not as part of this server).

## 5. Testing

- Pure halves unit-tested in Rust: request framing/parse, token compare
  (constant-time), path confinement, and **scope enforcement** — project A's
  token acting on project B's tab keys, files or activation must refuse, and
  the refusal is a named test per verb, not a property assumed from the
  lookup.
- A tripwire test in the `browser.rs` tradition: scan the MCP surface for
  tools that accept an absolute path, return file contents, or write to a
  PTY — the three omissions §2 makes load-bearing, which would otherwise be
  silent if a later tool forgot them.
- `examples/mcp_probe.rs` (the `ollama_probe`/`synctex_probe` convention):
  drives the socket headlessly against a running app so "the tool is dead"
  and "the tool ran and was refused" are distinguishable without clicking.
- Vitest: dispatcher map, tab-kind gating parity with the ➕ menu.
- Live QA is the user's (never launch Tabtivity): enable the flag, register via
  `claude mcp add`, and walk one script from a Claude Code session in a
  terminal — status → list tabs → activate → open a file → confirm a
  *refused* shell tab → flip `mcp_allow_pty_tabs` → open one.

## 6. Decisions taken (security-first), and what they cost

The plan initially left three things open; they are now decided in the
conservative direction, on the principle that every widening should be a
deliberate later act, not a default:

1. **`open_tab {kind:"shell"}` ships gated off** (`mcp_allow_pty_tabs`,
   default off). On the host it adds no privilege, but a spawned PTY is the
   verb whose meaning changes most if the socket ever reaches a container —
   so the knob exists from day one and starts closed. Cost: the "open a shell
   tab" use case needs one settings flip, stated in the SettingsPanel row.
2. **`close_tab` is dropped from v1** — the only destructive verb, and no
   stated use case needs it.
3. **No all-projects token in v1** (§1.5). Cost: an agent that genuinely
   needs to orchestrate across projects (rare; none of the stated use cases)
   has no path until the explicit Settings action is built — and that is the
   point: cross-project reach should exist only once someone has asked for it
   in so many words.

Still out of scope: bridge access from other machines (if ever wanted it is
an SSH forward of the socket, never a TCP listener).
