# Remote projects on the phone — Plan

Status: **proposed, 2026-10-15. Nothing here is built.** Lets a paired phone
open the agent tabs of a remote (SSH) project, start new ones, and later read
their conversation and browse their files. Every step rides the desktop's
existing SSH connection; the phone never causes a login.

## Where it stands

- A remote project never reaches the phone. `discovery::mobile_local`
  (`services/mobile_control/discovery.rs:726`) admits only a local project that
  is neither a container nor a VM; its desktop twin is `mobileProject`
  (`components/mobile/MobileBridgeHost.tsx:384`). `docs/context/mobile_access.md`
  layer 2 says "No switch can widen this" — this plan changes that sentence.
- A remote agent tab already runs in tmux **on the SSH host** by default
  (`RemoteSpec.persist_sessions !== false`): `ssh_exec::wrap_pty_options` →
  `remote_command` nests the CLI in `tmux new-session -A -D -s <name>`, the
  name being the tab's persisted `TabEntry.tmuxSession`
  (`docs/context/tmux_sessions.md`). Claude/Gemini launch with
  `--session-id <uuid>`, and `ssh_exec::host_side_resume` already finds
  `<id>.jsonl` under the host's Claude project dirs.
- The phone attaches to a **local** tab by `tmux attach-session -t <name>`
  (`pty_bridge::tmux_attach_command`, `pty_bridge.rs:130`) and seeds history
  with `capture-pane` (`tmux_capture_command`). Tabs are the scope's
  `sessions/<id>/terminals.json` rows whose cwd lies under the project root,
  joined to live rows of a local `tmux ls` (`discovery.rs` ≈1150–1230).
- Every remote path shares one ControlMaster socket per target, `cm-%C` in
  `ssh_exec::control_dir()`; `resolve_control_path(spec)` names it and
  `control_master_alive(path)` checks it. `run_remote_script` runs a one-shot
  over it; `tmux_ls_script` / `parse_tmux_ls` /
  `session_visible_for_project` already list one project's remote sessions
  for the desktop's Sessions view.
- The desktop itself has no conversation, turn state or push for a remote
  tab: `agent_transcript::watch_targets` and `fresh_codex_session` bail out on
  `remote_target_for(...)` (`agent_transcript.rs:560`, `:698`), because the
  CLI's transcript and Tabtivity's hook records would be on the host.

## Decisions to confirm

1. **Consent.** A host-wide switch `tabtivity_mobile_host.remote_projects`
   (default off, read per catalog load like `shells_open`), and then the
   project's own Mobile switch, which the desktop starts offering for remote
   projects. Containers and VMs stay excluded. Per-phone lists apply as for
   any scope.
2. **The phone never connects.** It works only while the desktop's master
   for that target is up (`control_master_alive`). Otherwise the project is
   listed with `connection: "offline"`, its tabs `available: false`, and the
   phone says "Open this project on the desktop to connect". No phone request
   ever runs a connect, prompts, or touches OpenVPN.
3. **Agent tabs only.** Remote shell tabs stay off the phone even with
   `shell_tabs` on: a shell there is the whole remote account.
4. **No hooks on the host.** Tabtivity does not write the remote user's
   `~/.claude` / `~/.codex` (AGENTS.md: never edit another app's config).
   Turn state for remote tabs is read from the transcript instead (R5).

## Phases

### R1 — Remote scopes in the catalog (sidecar)

- `discovery.rs`: split `mobile_local` into the trust test (no container, no
  VM) and a `remote: Option<RemoteSpec>` on `ScopeSource`, read from the
  `projects.json` entry (`remote_target_for` source). A remote scope's `roots`
  are empty; its tabs are matched by project id + `expected_tmux` name, not by
  cwd (a remote tab's cwd is the host path).
- Live rows come from a remote `tmux ls` run through `run_remote_script` with
  `ControlMaster=no`, `BatchMode=yes` and the resolved `ControlPath`, filtered
  by `session_visible_for_project`. Asked only when a phone request needs the
  catalog, cached per target (10 s; 30 s on a careful/HPC host), never on a
  timer. A non-zero exit keeps the previous rows (the desktop's
  `hostSessions` rule) and marks the scope offline after two misses.
- `PublicProject` gains `connection: "live" | "offline"` (absent = local);
  `PublicTab` stays as is. `git`, `worktree`, `subagent_worktrees`,
  schedules, prompts: none for a remote scope in this phase.
- Tests: a remote record with the host switch off/on, with a container flag,
  with the Mobile switch off; master missing → offline without spawning ssh;
  ls rows from another project's path are not adopted.

### R2 — Attach over SSH (sidecar)

- `pty_bridge`: a remote tab's command is `ssh -tt -o ControlMaster=no -o
  ControlPath=<resolved> -o BatchMode=yes <target> tmux -u attach-session -t
  <name>`, with the same client options the local attach sets (check what
  `tmux_attach_uses_a_non_alternate_screen_mobile_client` covers and whether
  the host's tmux is old enough to need a fallback). History is
  `capture-pane` over `run_remote_script`.
- The 5 s re-check also re-checks the master: gone → detach with
  `connection_lost`. The desktop's own reattach runs `new-session -A -D`,
  which detaches the phone's client; the phone shows its usual reconnect.
- Spawned ssh joins the subtree reaping and the `RunEvent::Exit` teardown
  like any bridge PTY.
- Tests: argv shape (no `ControlMaster=auto`, no password path), quoting of
  the session name (`valid_tmux_session_name`), offline → refused before
  spawn.

### R3 — Desktop bridge: open, rename, close, start

- `mobileProject` admits a remote project when the host switch is on;
  `mobileScope` (`lib/agents/localTabSpec.ts:20`) likewise.
- Activate / rename / colour / reorder / close go through the existing tab
  operations (close detaches-and-kills through `closeTabInScope`, as on the
  desktop).
- **Create** (＋): only plain agents, through the desktop's normal remote
  spawn, so the tab gets its tmux name and `--session-id`. Refused with
  `remote_offline` when the pool is not connected — never a connect.
  `LaunchOptions` offers no worktrees, cloud launches or local models for a
  remote scope.
- Headless (no window): listing and attaching work if the master is still up;
  `Create` answers `desktop_unavailable`.
- Settings: Mobile → project access lists remote projects behind the host
  switch, with one line saying the phone only works while the desktop is
  connected. Strings through `i18n.ts`; `UntestedTag` row
  `mobile.remote.tabs`.

### R4 — Remote transcripts (desktop and phone)

Shared backend, used by the desktop's chat view and the phone's Focus chat.

- `agent_transcript` reads through a source: the local file as now, or the
  host's file over the master (`run_remote_script`: resolve
  `"$CLAUDE_CONFIG_DIR"`-or-`~/.claude`/projects/*/<id>.jsonl, then `stat` and
  `tail -c +<offset>`), keeping the 6 MiB tail cap and the `version`
  fingerprint (size + mtime) so an unchanged poll costs one `stat`.
- Claude and Gemini first (the id is ours). Codex mints its own id and
  reports it only to the hook, so a remote Codex tab stays without a
  conversation in this phase.
- After a `/clear` the conversation moves to a new id the host's hook would
  have recorded; without it the reader keeps showing the launch id's file
  and says the session was cleared. Not guessed from "newest file in the
  folder" (two tabs in one folder would cross).
- Desktop: `watch_targets` stays empty for a remote tab; the reader polls on
  its own clock (5 s; 15 s on a careful host), only while the pane is visible
  and the project connected.

### R5 — Turn state and pushes for remote tabs

- Derive working / needs-answer / idle from the transcript tail (last record
  an assistant turn that ended vs. a pending tool call vs. a pending
  `AskUserQuestion`). Feeds the desktop's tab dot and the phone's
  `agent_status`; the existing `agent_turn` edge then pushes as for a local
  tab.
- Only while the project is connected and someone is looking (a desktop pane
  or a phone poll); careful hosts at the slower interval.

### R6 — Read-only file browsing (optional)

The 📁 browser for remote projects: `files::list/read/search` behind a
`ProjectDir`-like trait whose remote side walks one segment at a time over
SFTP/`lstat`, refusing links, with the same sealed tokens and limits. Behind
`project_files` and the connection gate; no uploads.

## Out of scope

Remote shell tabs; schedules, held prompts and the sidecar's scheduler for
remote tabs (they type into local tmux); inbox, outbox, uploads and markup;
git overview; containers and VMs; a phone-initiated connect.

## Docs and gates

- AGENTS.md: the Frontend/Invariants line about phone scopes, and
  `docs/context/mobile_access.md` layer 2, rewritten for the switch.
- `docs/filemap_backend.md` rows for `discovery.rs`, `pty_bridge.rs`,
  `agent_transcript.rs`.
- Backend touches paths and process spawning: the Windows and macOS
  cross-checks from AGENTS.md before pushing.
- QA box in `todo/` with the four platform lines; live check needs a real
  host: open a remote project on the desktop, start Claude, open it on the
  phone, type, disconnect the desktop → phone shows offline.
