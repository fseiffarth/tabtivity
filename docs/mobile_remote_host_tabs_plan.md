# Remote-host tabs on the phone

*Status: plan, 2026-10-24, reviewed the same day (see the last section).
Phase 2 (remote-host part) of `docs/mobile_every_project_type_plan.md`.
Landed on develop 2026-10-24 (`d29097fa` through `caf2260a`), never run live;
handoff: `docs/mobile_remote_host_tabs_handoff.md`.*

## Why

The user: "show also remote agent tabs on phone". Phase 1 lists a remote
project and its **local** tabs (agents in the mirror). A tab that runs on the
project's host, or on a worker, is dropped by the catalog
(`discovery::tab_on_this_machine` → `runs_on_this_machine` → `tab_is_local`)
and by the window's twin (`src/lib/projectTabHost.ts` `phoneReachesTab`,
used by `MobileBridgeHost.tsx` `phoneTabs`). The phone attaches only to a
tmux session on this machine (`pty_bridge::tmux_attach_command`), and a
remote-host tab's tmux session runs on the host:
`ssh_exec::wrap_pty_options` → `remote_command(…, TmuxWrap::Session(name))`
→ `if command -v tmux …; then exec tmux set -g history-limit … ';'
new-session -A -D -s '<name>' …` on the host, run by the remote's
**non-login** `$SHELL -c` (ssh's exec; only the agent *inside* the session
runs under `$SHELL -lc`), over the shared ControlMaster
(`ssh_exec::ssh_pty_args`: `ControlMaster=auto`,
`ControlPath=<control_dir>/cm-%C`, `ControlPersist=600`).

What the code already gives us (verified 2026-10-24):

- A host tab's saved `tmux_session` has the same shape as a local one
  (`newTmuxSessionName`: `<prefix><scope>--<kind>-<uuid>`), so
  `discovery::expected_tmux` accepts it (old prefix included).
- `withTmuxSession` mints that name for **every** shell/agent tab, but the
  window only *wraps* a host tab in tmux when `shouldPersistTab` holds
  (`remote.persist_sessions !== false`, not `ephemeral`). So a name on the
  record does not mean a session exists on the host.
- The saved `cwd` of a host tab is not where it runs: `wrap_pty_options`
  always `cd`s into the target host's `remote_path` and ignores the tab's
  cwd. Agents are saved with the project's `directory` (state folder), script
  runs with `remote_path` (`shellScriptRun.ts`).
- A desktop close of a host tab leaves its host session running
  (`closeRemoteTab.ts`; only the Sessions view's × kills it).

## Fixed decisions (user, 2026-10-24)

1. **Ride the desktop's SSH connection.** The sidecar reaches a host tab's
   tmux session through the existing ControlMaster socket for that host. It
   **never opens a new connection and never prompts** (AGENTS: auto-connect
   never prompts; `hpc_hosts`). So a host tab is reachable only while that
   host's master is alive, which is normally while the desktop is connected
   to it (and up to `ControlPersist` after).
   Desktop tabs are not changed: no local tmux around `ssh`, no respawn.
2. **Shells come too, behind the existing switch.** Remote-host shell tabs
   are listed only while `tabtivity_mobile_host.shell_tabs` is on
   (`discovery::shells_open`), as local shells are.

## Decisions made while planning (change if wrong)

- **Which tabs.** A remote (not VM) project's saved tab that is not local
  (`tab_is_local` false: `location` `"remote"`, `"host:<id>"`, or a shell
  with no location), of kind `agent` (resumable, as today) or `shell`, not
  `sign_in`, not `cloud`, not `ephemeral`, no `tmux_attach`, carrying a
  `tmux_session` that passes `expected_tmux` — and only when the record's
  `remote.persist_sessions` is not `false` (the window's
  `persistSessionsEnabled`; otherwise no host session exists for the name).
  `"remote"` = the primary host (`remote::PRIMARY_HOST`), `"host:<id>"` =
  that worker from the record's `compute_hosts`. A worker id that no longer
  resolves → not listed (the desktop falls back to the primary at spawn, but
  the session the phone would attach to is wherever it last ran; not
  guessed). VM and container projects stay as they are (out of scope).
  Windows (`terminals_support() == "unsupported"`): no host tab is listed.
- **No mirror needed, no cwd check.** A remote project with no mirror on disk
  lists its host tabs anyway. Today `resolve_scope` reads no session file
  when `roots` is empty; for a remote project it reads it, and only local
  tabs still need a root. A host tab is **not** checked against
  `canonical_below_any(cwd, roots)` nor against the live pane's
  `pane_current_path`: the session always runs in the record's `remote_path`
  whatever cwd was saved, the session file is ours (state dir, not
  project-controlled), and the session is identified by its uuid-bearing
  name. A host tab's `ResolvedTab.cwd` is the empty string and is never
  used (next bullet).
- **Nothing local is read for a host tab.** `ResolvedTab` gets
  `place: TabPlace { Here, Host(HostKey) }` (raw, never serialized). Every
  sidecar reader that looks up a tab's `cmd`/`cwd`/`session_id` in local
  files skips `TabPlace::Host`: `headless::transcript` →
  `unavailable("unsupported")`; the no-window readings (status, model,
  prompts, subagent count from `live_sessions/*.turn` and transcripts) →
  none; `host.rs` `project_tab_worktrees` → `(None, [])`; `project_git`'s
  `tab_cwds` → the host tab left out; `chat_uncommitted::for_tab` already
  answers `unavailable("remote")` for any remote project.
- **The host's address comes from the record, not a global.** `ScopeSource`
  gets the project's hosts (primary + workers) parsed from the
  `projects.json` record the catalog already reads (`ProjectRecord.remote`
  is already a lenient `Value`; add `compute_hosts` the same way). Add pure
  helpers to `services::remote` over the JSON values (the existing
  `spec_from_entry` / `compute_hosts_from_entry` /
  `entry_is_remote_for_host` take a `ProjectEntry`; factor their bodies into
  `spec_from_value(&Value)` / `compute_hosts_from_value(&Value)` and call
  those from both), never `remote_target_for*` (which reads
  `storage::projects_path()`).
- **Liveness is probed in the background, never in a request.** A catalog
  load runs under the `CatalogCache` mutex (3 s TTL) on the path of every
  route and of each open terminal's 5 s re-check, so it must not touch the
  network or a socket. A refresher task in `host::run` (every 10 s, its own
  `spawn_blocking` work, hosts probed with a 5 s timeout each) builds a
  `HostLive` snapshot off-lock and swaps it into an
  `Arc<Mutex<HostLive>>` held by `CatalogCache` (set once in `host::run`);
  `load_fresh_with` clones it and passes it to `Catalog::load_with` (tests
  build one by hand; `Catalog::load` passes an empty one). The refresher
  never holds the catalog mutex. Per round:
  - targets = the hosts of Mobile-enabled remote projects that have at
    least one listable host tab (one pure fn in `discovery.rs`, used by the
    catalog's listing too so they cannot drift);
  - skip the round entirely while no phone session is live: add
    `AuthStore::has_live_session(now)` (its `sessions` map is private today;
    an unexpired entry counts);
  - per host: resolve the **literal** socket path with
    `ssh_exec::resolve_control_path(spec)` (`ssh -G`, connects nowhere,
    `None` on Windows or when it is not under `control_dir()`), cached per
    spec for the round. None, or no socket file there → `master: false`;
  - **while a window is up** (`timer_lease::holder_in(lease_file(state_dir),
    now).is_some()`, the file the scheduler already reads): `ssh -O check`
    on that literal path (no network). Dead → `master: false`, no sessions.
    Alive and **not** an HPC host: `tmux ls` over the master (the no-dial
    argv below with the constant `ssh_exec::tmux_ls_script()`, parsed by
    `ssh_exec::parse_tmux_ls`; exit 255 = transport failed, exit 0 = the
    answer, empty included). A failed or timed-out probe keeps the last
    answer (as `CatalogCache::live` does) for at most 60 s, then counts as
    dead. Alive and an HPC host (tagged in `hpc_hosts`; read from the
    sidecar's own `state_dir/settings.json` through a pure helper, not
    `hpc_mode::is_hpc_spec`'s global `load_settings`): no background tmux
    probe; its host tabs are `available` while the master is alive;
  - **while no window is up**: no `-O check` and no `tmux ls` at all — the
    socket file's presence alone marks the host `available` (a real check
    happens at the terminal upgrade, a foreground act). Reason: every mux
    connection, `-O check` included, resets the master's `ControlPersist`
    countdown (OpenSSH counts a mux client as an open channel), so a 10 s
    probe would keep a master the quitting window left behind alive forever.
    With the window up the masters are the desktop's anyway; a phone that
    stays attached keeps its master alive by use, which is foreground.
- **The no-dial ssh argv** (one builder in `ssh_exec`, pure, compiled on
  every OS, unit-tested; it does **not** call `ssh_common::authorize_dial`,
  since it never dials, and must not use `ssh_base_args`, whose
  `ControlMaster=no` falls through to a fresh key/agent login):
  `-q -e none -o BatchMode=yes -o ControlMaster=no
  -o ControlPath=<literal resolved path> -o ProxyCommand=false
  -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no
  -o PermitLocalCommand=no -o RemoteCommand=none [-p port] <target> -- <cmd>`,
  plus `-tt` for the attach, `-T` for the one-shots.
  - Why a literal path and never `%C`: `%C` is the hash of `%l%h%p%r%j`
    (`man ssh_config`, OpenSSH 10.2 here) and `%j` is the ProxyJump; a
    command-line `ProxyCommand` suppresses a configured `ProxyJump` (first
    one wins), so `%C` would hash differently from the desktop's master for
    every ProxyJump host and the tab would never be reachable.
  - Why it cannot dial: OpenSSH's `ssh.c` tries `muxclient()` on the
    ControlPath before resolving or connecting; with `ControlMaster=no` a
    missing socket, a dead master, or a master that refuses the session (e.g.
    sshd `MaxSessions` reached) falls through to a normal connection, which
    `ProxyCommand=false` turns into running `false` locally: no DNS lookup, no
    TCP connect, exit 255. The command line wins over the user's
    `ProxyCommand`/`ProxyJump`. Test: a dead literal path fails fast; check
    with `ssh -v` that no "Connecting to" line appears (R adds this as an
    ignored-by-default test or a documented manual check).
  - `-e none`: the phone's keystrokes go through the ssh client's PTY, so
    `~.`/`~C` escapes must be off. `-q` keeps "Shared connection … closed"
    out of the phone's screen. `RemoteCommand=none` and
    `ClearAllForwardings=yes` stop a user config from breaking the command or
    asking the master for its port forwards.
  - Host-side commands are fixed strings with `shell_quote`d arguments, run
    the way the desktop's wrap runs tmux (plain `tmux` in the non-login
    `$SHELL -c`, so the same binary and `TMUX_TMPDIR`/server):
    `exec tmux -u attach-session -t '<name>'`,
    `tmux -u capture-pane -p -e -J -S -<lines> -E -1 -t '<name>'`,
    `tmux -u display-message -p -t '<name>' '#{window_width}x#{window_height}'`.
    No `=` exact-match prefix (older HPC tmux lacks it; the name is unique
    and validated). The tmux name is checked against `expected_tmux` and
    `ssh_exec::valid_tmux_session_name` (`[A-Za-z0-9_-]`) before use;
    `ssh_common::ssh_target` already refuses a host starting with `-`, `@`
    or whitespace (`validate_arg`).
- **Attaching.** `pty_bridge::attach` takes an attach target:
  `Local { name }` (today's) or `Host { name, ssh: HostSsh }` (the literal
  path + spec, raw, never serialized). Each gives the three commands the
  bridge runs: attach, capture (history replay) and window size. For `Host`
  the attach is `ssh -tt …` with `TERM=vt100` set on the ssh process (the
  mux client forwards it to the remote PTY); capture and window size are
  `ssh -T …` one-shots run with a timeout (`output_within`, 5 s) — the local
  ones have none, a hung host must not pin a blocking thread. The window-size
  poll runs only while a phone is attached (a foreground act), so it is
  allowed on HPC hosts too. The viewer registry stays keyed by name.
  `host::terminal` re-checks the master (`-O check` on the literal path,
  `spawn_blocking`, timeout) before the upgrade, window or not: dead →
  `409 host_offline`. The 5 s re-check (`recheck` over `Catalog::grants`) is
  unchanged in shape, but a host tab that is still listed and has gone
  unavailable closes with reason `host_offline` (retry false), not
  `access_revoked`.
- **What crosses the browser API:** one new boolean on `PublicTab`,
  `on_host` (true for a host tab), and the codes `host_offline` (HTTP and
  terminal close reason) and `tab_on_host`. No host name, worker id, path,
  socket path or tmux name crosses (AGENTS: `mobile_control`).
- **Routes that would act on this machine for a host tab** — each answers
  `409 tab_on_host` (the phone hides the control):
  - inbox upload (`host.rs` `inbox_upload`, `POST /tabs/{id}/inbox`, the
    composer's "From this phone"), desktop images (`desktop_images` /
    `attach_desktop_image` via `inbox_project`, "From the desktop") and Mark
    up Submit (`markup_submit`, `POST /tabs/{id}/markup`): they put a file in
    the mirror's `.tabtivity/inbox/`, which the host agent cannot read;
  - sign-in (`sign_in_tab`: would start a *local* sign-in agent for the CLI)
    and `sign_in_callback` (would deliver the code to a loopback port on this
    machine, not the host's CLI);
  - `POST /projects/{id}/activate?tab=<host tab>` (the phone's "restart for
    phone" path; it would switch the desktop's project for a tab the window
    can never wrap; `wrapAgentTabForPhone` answers `session_gone` for it
    anyway);
  - **with no window only** (the headless arm; with a window the desktop
    answers, typing into its own PTY of the tab as it does today): schedule
    create/update/delete (`schedule_create` and the `{schedule_id}` route),
    held prompts (`hold_prompt`, `edit_held_prompt`), a stored prompt's
    send-now (`…/prompts/{prompt_id}/send` aimed at a host tab) and
    `undo_clear_headless` — the sidecar's scheduler types only into local
    tmux.
- **Routes that need no change:** `chat_uncommitted::for_tab` (remote →
  `unavailable("remote")`); headless transcript (above); rename, colour,
  order, prompt record, outbox list, inbox read, markup questions (window);
  headless close (`scheduler::Runner::kill` runs local `tmux kill-session`,
  finds no such local session, which `kill_failure_is_already_gone`
  accepts; the record is removed and the host session keeps running, as a
  desktop close does — pin it in a test); worktree list/move
  (`worktree_movable` is already false for remote, so the phone shows no
  chip; the routes go to the desktop, whose `agentWorktreeSwitch.ts` rule
  refuses a remote project's tab — W checks that it still does once
  `phoneTabs` lists host tabs).
- **The scheduler, as it is (unchanged, pinned):** `scheduler::targets` does
  not filter by locality, so with no window a desktop-made schedule on a host
  tab finds no local session, `headless::restart_options` refuses
  `NotAttachable` (logged at most once per 60 s backoff) and occurrences past
  the hour are recorded missed. This plan does not change it; a test pins
  that no restart is launched for a host tab.
- **Phone create and reopen are unchanged:** (superseded for create,
  2026-10-25: the ＋ sheet's "Runs on" dropdown starts an agent on a host —
  `CreateTabRequest.host`, resolved by the sidecar from
  `ResolvedProject::machines`, only while `ssh_exec::master_alive`; the window's
  `createOnHost` saves it at that location) a phone ＋ in a remote project
  still starts a local agent in the mirror; "Recently closed" still lists
  only local tabs.
- **Window side.** `MobileBridgeHost.phoneTabs` filters by `phoneReachesTab`,
  and every per-tab handler reads through it (statuses, timings, prompts,
  turn snapshot, schedules, `scheduleTargetTab`, `mobileTargetTab` → close,
  rename, colour, sign-in/teleport `like_tab`), so all of them would answer
  `tab_not_found` for a host tab. Split the twin in `projectTabHost.ts`:
  `phoneListsTab` (the catalog's rule at table level: a remote non-VM project
  lists every tab; VM local only; container as before) used by `phoneTabs`,
  and the existing `phoneReachesTab` kept for create/reopen
  (`closedPhoneTabs`, `reopenMobileTab`). Over-inclusion is harmless: the
  window only acts on tmux names the sidecar resolved from its catalog.
  `wrapAgentTabForPhone` already answers `session_gone` for a host tab; keep
  it.
- **Pushes** need no change: `host::agent_tab_ref` finds a host tab in the
  catalog once it is listed, so its turn edges reach the phone.
- **The phone.** `TabRow.on_host?: boolean`. A host tab's card shows a small
  "on host" chip (reuse an existing chip class of `TabCard`'s
  `tab-card-meta`; no new treatment). An unavailable host tab says why in
  one line ("Connect this project on the desktop to open it") and its card
  never calls `startTab`/`activate` (`Project.tsx`'s `onOpen` falls to
  `startTab` for an unavailable agent tab today). Map `host_offline` and
  `tab_on_host` in `connection.ts` (HTTP and the terminal's closing
  reason). Hide "From this phone", "From the desktop", Mark up Submit and the
  sign-in action on `on_host` tabs; hide the schedule/held-prompt controls
  only when the desktop is away (`desktop_available === false`). The phone
  shares the desktop's dictionaries (`src/lib/i18n.ts` + `src/lib/i18nDicts/
  {de,es,fr,it}.ts`, imported as `../../../src/lib/i18n`). The pill is the
  phone's own markup, `isUntested("<id>") && <span className="untested">
  {t("mobile.newTab.untested")}</span>` (from `src/lib/untested.ts`; the
  phone honours `show_untested_tags` via `/api/v1/status`), with a row whose
  id is the chip's i18n key (the register's rule), e.g.
  `mobile.project.onHost`. Reword the strings that now lie:
  `mobile.project.hostRemote` ("…not tabs running on the remote host") and
  `lessons.mobileLesson.projectAccessBody` ("A remote project shares its
  agents that run on this computer…"), in all five dictionaries.

## Known limits (stated, not fixed)

- Reachable only while the desktop (or `ControlPersist`, 600 s after the
  window lets go) holds the host's master. With the window closed for longer,
  host tabs show as unavailable. With no window the listing trusts the socket
  file (no probe), so a dead master's leftover socket shows `available` until
  the upgrade's `-O check` answers `host_offline`.
- The sidecar must compute the same `control_dir()` as the desktop
  (`XDG_RUNTIME_DIR` / state dir / `/tmp/<slug>-ssh-<uid>`); a sidecar unit
  started without the desktop's `XDG_RUNTIME_DIR` finds no socket and lists
  every host tab unavailable (safe).
- sshd's `MaxSessions` (default 10 per connection) caps the master's
  sessions; with many desktop host tabs open the phone's attach or probe can
  be refused, which reads as unavailable / `host_offline`, never a dial.
- The remote wrap uses `new-session -A -D`, so when the desktop tab
  reattaches (a reconnect), tmux detaches the phone's client; the phone
  reconnects like after any drop.
- No transcript-based reading, status record or "uncommitted" card for a
  host tab where the desktop has none either (hooks record on the host).
  The phone falls back to the screen, as for a tab whose transcript is
  unavailable.
- An HPC host's tab can show `available` with its session already ended
  (no background probe); opening it shows the session ended.
- The per-user server daemon (`Listen::Unix`) runs the same code; whether it
  holds a timer lease while a browser client is open decides which liveness
  branch it takes. Not verified; harmless either way (it never dials).

## Steps

### R. Sidecar (Rust): catalog, liveness, attach, refusals

1. `services/remote.rs`: pure `spec_from_value` / `compute_hosts_from_value`
   (the existing `ProjectEntry` helpers call them), tested.
   `services/ssh_exec.rs`: the no-dial argv builder (`host_mux_args(spec,
   control_path, tty)`), the attach/capture/window-size host command strings,
   a strict `master_alive(path)` (spawn failure = not alive; the existing
   `control_master_alive` defaults to `true` for its delete-guarding callers),
   tested on shape (literal ControlPath, no `%C`, `ControlMaster=no`,
   `ProxyCommand=false`, `BatchMode=yes`, `-e none`, `--` before the
   command, quoting of a hostile name, no `authorize_dial`).
2. `mobile_control/discovery.rs`: `ProjectRecord` reads `compute_hosts`
   leniently and `remote.persist_sessions`; `ScopeSource.hosts`;
   `TabPlace` on `ResolvedTab` and `PublicTab.on_host`; `resolve_scope`
   reads a remote project's session file without a root and lists host tabs
   by the rules above, `available` from the `HostLive` snapshot passed into
   `load_with`; `host_probe_targets(state_dir)` sharing the listing rule;
   `CatalogCache` holds the `Arc<Mutex<HostLive>>`; `live_sessions` counts
   host tabs. Existing tests stay green; new ones: worker tab, unknown
   worker, no mirror, `persist_sessions: false`, VM unchanged, shells behind
   `shell_tabs`, master dead → unavailable, Windows lists none (via the pure
   `terminals_support_on`), `on_host` serialized and nothing raw.
3. `mobile_control/host_live.rs` (new, keeps `host.rs` from growing): the
   refresher, `HostLive`, the window/phone gates, the 60 s carry-forward, the
   pure HPC lookup; `auth.rs` `has_live_session`. `host.rs`: wiring in
   `host::run`, `host_offline` check in `terminal`, every `tab_on_host`
   refusal listed above, the host-tab skips in `project_tab_worktrees` /
   `project_git` / the no-window readings; `headless.rs`: `transcript`
   unsupported for a host tab, the headless-write refusals.
4. `mobile_control/pty_bridge.rs`: the attach target and its three commands
   (one-shots under a timeout); `recheck` → `host_offline` for a host tab
   still listed but unavailable.
5. `protocol.rs`: the codes documented beside the others; scheduler
   (`no restart for a host tab`) and headless-close tests from the list
   above.
6. Docs: `docs/context/mobile_access.md`, `docs/context/mobile_sidecar.md`
   (pty_bridge + discovery + host_live lines), the backend filemap rows for
   `mobile_control/discovery.rs` (it says remote tabs need a local tmux
   session) and the new `host_live.rs`.

### W. Window + phone (TS)

7. `src/lib/projectTabHost.ts`: `phoneListsTab`; `MobileBridgeHost.tsx`
   `phoneTabs` uses it; create/reopen keep `phoneReachesTab`. Add a `lists`
   column to the shared `src/__tests__/mobile/projectHostReach.fixture.json`
   (rule: `lists = reach || host == "remote"`; the table has no tmux/live
   facts) and assert it in `src/__tests__/mobile/MobileTabReach.test.ts`.
   Frontend filemap row for `lib/projectTabHost.ts` and the
   `MobileBridgeHost` row's "only those with a local tmux session" clause.
8. `mobile-web/src/api.ts` (`TabRow.on_host`), `components/TabCard.tsx`
   (chip, unavailable line), `screens/Project.tsx` (no `startTab` for
   `on_host`), `screens/Terminal.tsx` / composer / `components/MarkupView.tsx`
   (hide "From this phone", "From the desktop", Submit, sign-in; schedule
   and held-prompt controls only without a window), `connection.ts` codes
   (HTTP + closing reason); strings in `src/lib/i18n.ts` and the four
   `src/lib/i18nDicts/*.ts`, including the two rewordings above;
   `npm run mobile:bundle`.
9. `src/lib/untested.ts` row `mobile.project.onHost` (used by the chip's
   pill); `docs/help/mobile.md` (what a host tab needs: the project connected
   on the desktop); a QA box next to **31ci** in
   `todo/group-h-crossplatform.md` (`rg -n "31ci"`; never read it whole) with
   the four platform children.

## Organisation

Shape: **disjoint subsystems once an interface is fixed, plus a security
review** (the sidecar part is `mobile_control` + ssh, an invariant area). The
contract is fixed in this plan (`PublicTab.on_host`; `host_offline` as HTTP
code and terminal close reason; `tab_on_host` on the routes listed), so the
Rust and TS parts run in parallel in separate worktrees. The user capped
this run at **five subagents in total**:

| # | Agent | Plan steps | Main files | After |
|---|---|---|---|---|
| 1 | Plan review | whole plan | this file | — |
| 2 | R: sidecar | 1–6 | `remote.rs`, `ssh_exec.rs`, `discovery.rs`, `host_live.rs` (new), `host.rs`, `headless.rs`, `auth.rs`, `pty_bridge.rs`, `protocol.rs`, backend docs | 1 |
| 3 | W: window + phone | 7–9 | `projectTabHost.ts`, `MobileBridgeHost.tsx`, the fixture + its TS test, `mobile-web/src/*`, `i18n.ts` + dicts, `untested.ts`, help, todo, frontend filemap | 1 (beside 2) |
| 4 | Security review of R | R's diff | no-dial argv (literal path, escapes, forwards), quoting, what crosses the API, HPC and the no-window gate, refusals | 2 |
| 5 | Final review | whole range | integration, i18n, untested row, filemaps, brand/privacy, cross-OS | 3, 4 |

R is the larger slice (about 1.5–2 days, one subsystem); it stays one agent
rather than spending a sixth, and records progress in the handoff file so a
respawn can resume. Suggested order inside R: 1 → 2 → 4 → 3 → 5 → 6.
Worktrees `.claude/worktrees/mobile-host-r` and `.claude/worktrees/mobile-host-w`
(hardlinked `node_modules`), branches `mobile-host-r` / `mobile-host-w`;
handoff `docs/mobile_remote_host_tabs_handoff.md`.

Disjointness: R touches no TS and no fixture; W touches no Rust. The one
shared artefact is `projectHostReach.fixture.json`: **W owns it** (adds
`lists`). The Rust assertion on that column
(`the_project_host_table_matches_the_windows` checking the catalog's listing
rule against `row["lists"]`) is a merge-time hunk the main agent adds after
merging both branches (R cannot run it green before W's column exists).
Hot shared files: only W touches `untested.ts` and the dictionaries (both
also carry uncommitted edits from another session in the main tree; merge,
never overwrite); only R touches the backend filemap, only W the frontend
one. The main agent merges R, then W, into develop, then adds the fixture
hunk and runs the gates.

## Verification

- Gates: `scripts/gates.sh` (build, tests, clippies, the daemon build since
  `mobile_control` is in it), `npm run mobile:bundle`, `npm run
  backend:stale` after landing. Cross-OS: the argv builders and command
  strings are pure and compile and test on every OS; only the refresher's
  behaviour is gated (`terminals_support()`, `resolve_control_path` is
  `None` on Windows). Run `scripts/ci-local.sh` before any push (Windows
  clippy, `aarch64-apple-darwin` check).
- Live (manual, the user; never run by an agent):
  1. A remote project with Mobile on and an agent tab running on the host,
     desktop connected (green lamp). The phone lists the tab with the "on
     host" chip; open it, type a prompt, see the reply; the desktop tab
     shows the same.
  2. Disconnect the project on the desktop: the tab shows the "connect on
     the desktop" line and does not open; an open phone terminal closes with
     that line; no ssh login or prompt appears anywhere (`ss -tnp` shows no
     new `:22` connection from the sidecar).
  3. A shell tab on the host: hidden while "shell tabs" is off, listed when
     on.
  4. A worker tab (`host:<id>`) on a connected worker: listed and opens.
  5. "From this phone", "From the desktop", Mark up Submit and Sign in are
     not offered on a host tab.
  6. A host reached through `ProxyJump` in `~/.ssh/config`: its tab is
     listed and opens (the literal-path rule).

## Plan review (2026-10-24)

Checked against the code; changes made in place:

- **No-dial argv fixed.** `%C` hashes `%l%h%p%r%j`; the planned
  `ProxyCommand=false` suppresses a configured ProxyJump, so `%C` would
  never match the desktop's socket for a ProxyJump host. Now: the literal
  path from `resolve_control_path` (`ssh -G`). The OpenSSH claim holds (mux
  client before resolve/connect; a refused mux session also falls through,
  which `ProxyCommand=false` stops). Added `-e none`, `-q`,
  `ClearAllForwardings`, `RemoteCommand=none`, `--`; no `authorize_dial`,
  no `ssh_base_args`.
- **`run_remote_script`/`run_remote_shell`/`remote_tmux_list` dial** (fall
  back to a fresh login). Only `tmux_ls_script()` and `parse_tmux_ls` are
  reused. tmux runs in the non-login `$SHELL -c` (the plan said login
  shell); no `=` prefix (old HPC tmux).
- **Probes must not keep masters alive:** any mux connection resets
  `ControlPersist`. Background `-O check`/`tmux ls` only while a window holds
  the timer lease and a phone session is live; with no window, socket
  presence only. Added `AuthStore::has_live_session` (none exists).
- **Wrong claim fixed:** the tmux name is minted even with
  `persist_sessions: false`; the catalog now reads that flag. The cwd rule
  is dropped (`wrap_pty_options` always uses `remote_path`); a host tab's
  `cwd` is never read, and worktrees, git dots and readings skip it.
- **Missing sites added:** desktop images, sign-in, sign-in callback,
  activate-with-tab, headless schedule/held/send-now/undo-clear; the
  terminal close reason `host_offline`; timeouts on host one-shots; HPC
  lookup from the sidecar's own `state_dir`. The scheduler claim was wrong:
  it does not skip host tabs (it fails restart `NotAttachable`); pinned
  as-is.
- **Phone facts fixed:** dictionaries are the desktop's shared ones; the
  pill is `isUntested` + `.untested` span, id = i18n key; QA box goes in
  `todo/group-h-crossplatform.md` beside 31ci; two strings that now lie
  (`mobile.project.hostRemote`, the lesson body) get reworded; no `startTab`
  for host tabs.
- **Disjointness:** the shared fixture is `projectHostReach.fixture.json`
  (not a `MobileTabReach`-only table); W owns it, the Rust assertion is a
  merge-time hunk. R grew (`headless.rs`, `auth.rs`, new `host_live.rs`) but
  stays one subsystem.

Blocking questions: none. A non-blocking one, decided here: with no window,
host tabs list from socket presence (no probe); say if you'd rather they
show unavailable whenever the window is closed.
