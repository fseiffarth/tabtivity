# Local-models-only projects — plan

Status: design only, nothing implemented (2026-11-08). Decisions D1–D4 at
the end, taken by the user the same day.

## Intent

A project can be marked **Local models only**. Then no cloud AI model reads
its files: only agent tabs on an installed local Ollama model start in it,
and no Tabtivity feature hands its files to a cloud model.

Inside that mode the user picks a second switch, **Cut network** (per
project, default off):

| Mode | Guarantee |
| --- | --- |
| Local models only, network on | No cloud agent CLI starts here; a local tab starts only on a model confirmed local at spawn; Tabtivity itself sends nothing from here to a cloud model. **Not** covered: what the local agent does with its own network (a fetch tool, a prompt-injected `curl`, a `git push`, switching to an Ollama cloud model mid-session). |
| Local models only, network cut | The above, plus: a local tab's fence has no network. Its only way out is a Tabtivity relay to the local Ollama that checks every request names a local model. |

The UI states the guarantee of the chosen mode in those words, not a softer
"private" label.

Why a project and not a folder inside one ("chest"): a local agent that can
read the chest can write the rest of the project, which cloud agents read;
git history, box roots, root-console views and editor completion also see
the whole folder. The project folder is a boundary the fence already
enforces. Discussion: chat 2026-11-08.

## What exists to build on

- `PtyOptions.local_model` picks the `.local` agent home but **grants
  nothing** — it comes from the renderer. Never trust it for this gate.
- `local_drivers::local_launch_line_ok(driver, model, cmd, args)` — the
  check a restored local tab and the phone already pass. The gate's
  argv check.
- `ollama_client::model_is_local_at` / `tab_model_is_local_at` — the
  mail local-read check (gap 25): the model must be listed by the
  endpoint without a remote (Ollama cloud models run on ollama.com) and
  no other listed model shares its alias. Plus `LISTENER_REFUSED`
  (`loopback_owner`, gap 50a) and the loopback-only `ollama_host` rule
  (`ollama_allow_remote_host`). Reuse all three as they are.
- Spawn gates in `agent_fence`'s Linux wrapper: `server::share::spawn_gate`
  and `check_assistant_spawn`. The new gate sits beside them.
- `mask_private_state` — final masks spliced after every bind, so overlaps
  never re-expose. The new mask goes there.
- `roots_for_scope` / `compute_fence_roots` / `box_store::box_allowed_roots`
  and `root_project_read_only_paths` — every path by which one project's
  folder enters another tab's fence.
- `docs/context/agent_security_level.md` (design only) — same "backend is
  authoritative at every spawn, refuse when unsure" model. If both ship,
  the global level is a ceiling and this flag narrows per project.

Name clash: `roots_for_scope(.., local_only)` already means "the local copy
of a remote project". The new flag is `local_models_only`, never
`local_only`.

## Settings shape

On the trusted `projects.json` entry (`ProjectEntry.extra`), never in the
in-folder `project.json` (attacker-controlled):

```json
"agent_privacy": { "local_models_only": true, "cut_network": false }
```

Absent = today's behaviour. Unknown fields round-trip. Written through
`patch_json`. A new Tauri command `set_project_agent_privacy` (`async`, takes
`tauri_host::Ctx`, `command_class` row: `client` — the phone may read it
but only the desktop sets it; see decision D4). Regenerate
`commandClasses.ts`.

Setting the flag is refused (with a message naming the project) when:
- the project is remote, remote-only, a container or VM project (v1: local
  folders only; containers are phase 4);
- another registered project's folder lies **inside** it (a local tab would
  write into a project whose cloud agents read it);
- `ollama_host` is not loopback.

## Phase 1 — no cloud model reads it (network on)

### 1a. The spawn gate (`services::agent_privacy`, new, `AppHandle`-free)

One pure decision `privacy_gate(project, opts, settings) -> Result<Privacy, Refusal>`
called on **every** agent spawn path, before the fence is built:
tab spawn, resume (`agent_session` re-applies), restore of a persisted tab,
phone-started tabs (`mobile_control`), scheduled/warm-up launches, the
`agent_bin` shim from a shell tab, sandbox/container spawns, the server
daemon's spawn. A source scan test (like `commands/git/tests.rs`) asserts
every spawn site calls it.

For a scope whose roots include a local-models-only project, the spawn is
allowed only when all hold:
1. `local_launch_line_ok(driver, model, cmd, args)` — the argv is a genuine
   local launch line. The driver/model pair comes from the backend's own
   `prepare_local_agent` record for this tab, not the renderer.
2. `tab_model_is_local_at(endpoint, model)` passes, the listener owner check
   passes, and `ollama_host` is loopback.
3. No API-key injection: `agent_api_keys::inject_launch` and the admin key
   path are skipped, and provider key variables are removed from the env
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`,
   `OPENROUTER_API_KEY`, … — a list in `agent_privacy` with a test). The fence
   does not filter env, and vibe falls back to its cloud default when its
   config is missing.

Everything else (Claude/Codex/Gemini on their logins, custom registry CLIs,
the Host session) is refused with a fixed category `local_models_only`. Fail
closed: an unreadable `projects.json`, an unreachable Ollama or an
unreadable model list refuses.

When the flag is turned on, running cloud agent tabs in the project are
terminated (whole subtree, as `kill` does) and their restore entries are
marked refused. Changing `cut_network` asks to restart the project's local
tabs (fence args are fixed at spawn); it never restarts them silently.

### 1b. Keep the folder out of every other fence

- **Mask** each local-models-only project folder in every fence except its
  own verified tabs (empty tmpfs, spliced in `mask_private_state`'s
  position). This covers a parent project's folder that contains it, the
  user's toolchain read-only allowlist, and anything added later.
- **Boxes:** `box_allowed_roots` drops local-models-only members for any
  tab that is not a verified local tab of that project. The project's own
  local tabs get **only their own folder**, never box roots (otherwise they
  write into projects cloud agents read). `box:<id>` tabs never get the
  folder. The box editor shows a note on such a member.
- **Root console:** `root_project_read_only_paths` skips the project.
- **Local-model home:** `vibe_local/<model>` is shared by every tab of that
  model across scopes (`agent_authority.md`, gap 30). This project's tabs
  get a per-project home (`vibe_local/<model>.<project_key>`) so logs and
  history holding its content stay apart. Same control-path pinning.

### 1c. Non-agent paths to a cloud model

Audit and close each for files under the project:
- Copilot inline completion (`docs/context/copilot_completion.md`): off.
- Tabby attachments (`assistant_attach.rs`): refused while Tabby runs a
  cloud CLI; allowed on a local Tabby model.
- Send-to-project / send-to-project-context and markup prompts: nothing from
  this project goes to a tab outside it. Inbound sends are fine.
- Root MCP tools that return project content (to-do board, project
  listing details): audit; return no file content for this project to a
  cloud caller.
- Mail AI and voice don't read project files. Re-check in the audit anyway.

The audit result goes in `docs/context/local_models_only.md` (new, one
section per path), so a later feature has a checklist.

### 1d. UI

- Project settings: a **Local models only** switch, and beneath it the
  **Cut network** switch, each with the guarantee text from the table above.
  Built with the shared frame (`add-menu` skill), strings in `i18n` (all
  five dictionaries; English holds every key).
- The project pill shows a small lock badge; the ＋ menu in that project
  lists only local-model rows. Cloud rows are hidden, not just disabled,
  and the backend refuses them anyway.
- A refused spawn shows the backend's message, naming the switch.
- `UntestedTag` on both switches, rows in `src/lib/untested.ts`.

### 1e. Limits (stated in the UI help topic and the context doc)

- Shell tabs are the user's and are unfenced. A `cat` typed there and pasted
  into a cloud chat is the user's act. A cloud CLI typed into a shell tab
  goes through the shim, which hits the gate.
- The root console's Host session is unfenced by design. It is refused
  `cwd` in the project, but it can read the folder like any host process.
- Windows has no fence. The gate still refuses cloud CLIs, but nothing hides
  the folder from other processes. The settings text says so.
- Git remotes, sync and export are about machines, not models (D3); a
  server share warns.

## Phase 2 — Cut network (Linux)

### 2a. Fence

With `cut_network` on, the project's local tabs get `--unshare-net`.
bubblewrap brings up `lo` inside the new namespace, so the agent's loopback
is its own and the host's Ollama and Tabtivity MCP ports are unreachable.
Abstract-socket Landlock scoping stays as it is.

### 2b. The local lane (`services::local_lane`, new)

CLIs talk TCP to `127.0.0.1:<port>`, so two halves:

- **Host side:** per tab, a Unix socket
  `<state_dir>/local-lane/<hash-of-pty-id>.sock` (0600, created by
  Tabtivity, removed in the tab's teardown and in `RunEvent::Exit`). It is
  bind-mounted into the fence at a fixed path under the fence's private
  `/run`. Tabtivity forwards each accepted request to the configured
  loopback Ollama only.
- **In-fence side:** the fence's command becomes Tabtivity's own binary in a
  relay mode (the same way the `agent_bin` shim calls the running binary;
  mounted read-only). It listens on the fence's `127.0.0.1:11434` (or the
  configured port), relays to the socket, then execs nothing: it is the
  CLI's parent and the CLI is started as its child. It exits with the CLI.
  Verify this in a spike first. The fallback is a static helper in
  `<state_dir>/bin` (`brand` slug name). No `socat` or `pasta` dependency.

The host side checks every request (the fence side is untrusted):
- **Paths allowed:** `/api/chat`, `/api/generate`, `/api/embed`,
  `/api/embeddings`, `/api/tags`, `/api/show`, `/api/ps`, `/api/version`,
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`,
  `/v1/messages` (the Anthropic-compatible API `ollama launch claude` uses).
  **Refused:** `pull`, `push`, `create`, `copy`, `delete`, `blobs`, and
  anything unknown. `push` uploads a model, and a `pull` name can carry data.
- **Every model a request names** passes `model_is_local_at` (cached, with
  the same TTL idea as `model_allowlist`). This is what stops a mid-session
  `/model` switch to a cloud model, which network-on mode cannot stop.
- `/api/tags` and `/v1/models` responses are filtered to local models.
- Body cap, one-request-per-connection HTTP/1.1, streaming responses passed
  through, timeouts. A refusal is a JSON error the CLI can show.

### 2c. Tabtivity tools under the cut

MCP lanes are loopback HTTP too, so the relay carries a second port to
Tabtivity's MCP server and allows only lanes that don't let data leave:
cockpit (own tab), help, markup, and the phone send (D2). Refused: web lane
(`/mcp/web`), git push and release, schedule, root/mail tools. The bearer
tokens are unchanged. The relay only filters which lanes are reachable.

### 2d. Per-driver verification

Under `--unshare-net` some CLIs stall on update checks, telemetry or a
login probe. For each driver in `LOCAL_DRIVERS` (opencode, pi, claude, codex,
droid, openclaw, cline), run the `verify-cli` harness with the network cut
and record: starts, answers a prompt, edits a file, no hang. Set the known
quiet-mode env per driver (for example Claude's
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, update checks off). A driver
not yet verified is refused in cut mode with a message naming it, rather
than left to hang. Results go in the context doc.

## Phase 3 — macOS

Seatbelt can deny `network*` except the relay's Unix socket. Same lane,
same relay. Until then, turning on Cut network on macOS is refused with a
message (fail closed). The phase-1 gate works on macOS from the start.

## Phase 4 — container and VM projects (later)

The container's agent with `--network none` and the lane socket mounted in.
The VM gets a model through a forwarded socket only. Until then the flag is
refused for these project kinds (phase 1 settings check).

## Tests

- `agent_privacy` gate: each spawn kind × {cloud CLI, local launch line +
  local model, local line + cloud model, renderer `local_model: true` on a
  cloud argv, unreachable Ollama, non-loopback `ollama_host`, foreign
  listener} → expected allow/refuse; env scrub list; API-key injection
  skipped.
- Source scan: every spawn site calls the gate.
- Fence args: mask present in other scopes' fences, including a parent
  project and an allowlist overlap; box roots dropped both ways; root
  read-only list skips it; per-project vibe home; `--unshare-net` only when
  cut. Cross-OS path construction (`Path::join`).
- Lane: path allowlist, model check per request (including `/v1/messages`
  and embeddings), `tags` filtering, body cap, socket perms and teardown.
  Relay round trip in a unit test over a socketpair. A `bwrap` integration
  test is gated like the existing fence tests.
- Settings: round-trip of `projects.json` with and without the field;
  refusal cases (remote, nested project, non-loopback host).
- Frontend: the switches, the ＋ menu filtering, the refusal message,
  i18n keys in all dictionaries.

Gates: `scripts/gates.sh` for the touched set (backend + frontend, both
clippy variants, the no-default-features build since `services::` changes),
`git diff --check`, `npm run backend:stale`. Not run live by the agent.

## Live verification (for the user)

1. Mark a scratch project Local models only, network on. ＋ menu shows only
   local rows. A Claude tab restored from before is gone with a notice.
2. Start an OpenCode local tab. It works. In a Claude tab of another
   project, `ls` the scratch folder: empty.
3. Put the project in a box with another project. The box tab can't see it,
   and the local tab can't see the other member.
4. Turn on Cut network, restart the local tab. `curl https://example.com`
   fails, the model answers, `/model` to a `:cloud` model is refused.
5. Repeat 4 for each driver the verification table marks verified.

## Decisions (user, 2026-11-08)

- **D1 — Host session:** refuse its `cwd` in the project; document that it
  can still read the folder as an unfenced host process.
- **D2 — Phone send under the cut:** allowed (the phone is the user's own
  device). `tabtivity-send` stays reachable through the relay.
- **D3 — Machines vs models:** the flag is about models. Git pushes by the
  user, sync and export are unchanged; sharing to a hosted server shows a
  warning that other members' cloud agents could read it there.
- **D4 — Who sets it:** desktop only; the phone reads it (`command_class`
  `client` for the read, the setter not exposed to the phone).
