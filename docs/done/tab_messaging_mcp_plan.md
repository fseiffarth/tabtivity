# Tab messaging MCP — agent tabs of one project message each other

Status: steps 1–8 are implemented and reviewed on `develop` (2026-11-14); build
notes, deviations and the reviewer's flags are in
`docs/tab_messaging_mcp_handoff.md`. Nothing was run live: the manual
verification below is still open. Open design flags (stacked wake notices, wake
ignoring class, no liveness check) are listed in `todo/group-s-agents.md`.
Builds on the per-tab lanes (`docs/context/agent_mcp_wiring.md`,
`cockpit_mcp.md`, `markup_mcp.md`, `print_mcp.md`, `git_push_mcp.md`) and the
trust rules in `docs/context/local_models_only.md` and `agent_authority.md`.

## Why

Agent tabs of one project share the project folder and the scope's agent home,
but each runs in its own fence (private `/run`, `/tmp`, PID namespace, abstract
socket scope). Claude's own peer messaging dies there (registry in the shared
home, socket in the private `/run`, every fenced Claude is pid 2), and it is
Claude-only anyway. Today's workaround is a file mailbox. This lane gives every
registry CLI a small mailbox that Tabtivity routes outside the fence.

The lane adds **no data path that the shared folder does not already give**
same-project tabs. The security work is keeping it exactly that narrow, and
keeping agent-written text from ever being taken for the user's input.

## Fixed decisions

1. **Names.** Server `<slug>-tabs` (`concat!(app_slug!(), "-tabs")`), route
   `POST /mcp/tabs`, `Caller::Tabs`, env pair `app_env!("TABS_MCP_URL")` /
   `app_env!("TABS_MCP_TOKEN")`, module `services::tabs_mcp`
   (`src-tauri/src/services/mcp/tabs_mcp.rs`, new, `AppHandle`-free), setting
   `Settings::tabs_mcp`. Its own token lane: the token reaches `/mcp/tabs` only.
2. **Tools** (strict schemas, unknown keys refused, no scope/project/tab-id
   arguments):
   - `tabs_list {}` → `{self: {handle, label}, tabs: [{handle, label, cli}]}`:
     the caller's reachable siblings (decision 5), nothing else.
   - `tabs_send {to, text, replyTo?}` → `{status: "queued", id}`. One
     recipient; no broadcast.
   - `tabs_inbox {ack?: [id…]}` → drops the acked ids, then returns the
     caller's unread, oldest first, at most 10:
     `[{id, from: {handle, label}, sentAt, replyTo?, text}]`. Reading does not
     consume; only `ack` does (a lost reply loses nothing).
   No read receipts, no turn state of siblings, no presence beyond the list.
3. **Identity.** Bound at spawn, never an argument: the cockpit lane's binding
   (`cockpit_mcp::binding_for_spawn`: state dir, scope, saved workspace tab id;
   exactly one saved agent tab for the tmux session, attach-only tabs excluded,
   no binding = no grant) plus a **class** (decision 5).
4. **Handles.** `t_` + 16 hex of HMAC-SHA256 over `state ‖ 0 ‖ scope ‖ 0 ‖ tab
   id`, keyed with a random key minted once per process (`getrandom`; no
   entropy = no grant, as `mint_token`). Stable for the tab while the app runs
   (a respawn or `--resume` keeps it; a reopened tab has a new id, so a new
   handle). Labels are the saved tab label (agent- or user-chosen), shown as
   untrusted text. No project id, path, tmux name, pid, workspace id or uid
   appears in any reply; a test serializes every reply shape and checks.
5. **Who gets the lane, and who may exchange.**

   | Tab | Lane | Why |
   |---|---|---|
   | Local project agent tab (any registry CLI, tool-tagged Vibe) | in | `grant_lanes`' `project_lanes` predicate, plus a binding |
   | Local-model tab of a Local-models-only project | in, own class | all its siblings are verified local too |
   | Cut-network tab | out (decision 6) | `/mcp/tabs` stays off `local_lane::MCP_ALLOWED` |
   | Root console tabs, Host session | out | root agents hold cross-project authority; the Host session is unfenced |
   | Tabby (`assistant` scope) | out | its tool set is pinned to web + help; `grant_lanes` returns before any project lane |
   | Box tabs (`box:<id>`) | out (decision 5) | a box's view changes with its membership |
   | Remote-host, worker, VM, container tabs, `local_only` tab of a remote project, mail-reader VM | out | off this host's loopback or another folder (`Trusted::off_host`, `opts.sandbox`), as markup/print |

   **Exchange rule**, one pure function `may_exchange(a, b)` used by list,
   send and read: same state dir, same scope id, same class. Class is fixed at
   grant: `locked:<project>` when `agent_privacy::stamped(opts)` (the gate's
   stamp, `STAMP_ENV`), else `local` when the spawn gets the `<scope>.local`
   home, else `cloud` (decision 2: the last two never merge, in unlocked
   projects). An unknown handle, a handle of another project and a handle of
   another class answer the same `not_found`, byte for byte.
6. **Local-models-only enforcement** (the exfil rule), four layers:
   - *Grant*: class from the gate's stamp, never from the renderer's
     `local_model` flag or the saved tab's `kind`.
   - *Every call*: the scope's `projects.json` entry is re-read
     (`agent_privacy::is_locked`, a malformed record reads locked); locked now
     and the caller's class is not `locked:<that project>` → `unavailable`.
     Unreadable registry → `unavailable`. Covers the window between the switch
     and `ptys_to_end`.
   - *Message*: the sender's class is stored on the message; `tabs_inbox`
     filters on it again at read.
   - *Flip*: `agent_privacy::set` changing either flag purges the scope's
     mailbox (`tabs_mcp::purge_scope`), called beside the tab sweep in
     `src-tauri/src/commands/agent_privacy.rs`.
   Cross-scope reach (a parent project, a box, the root console seeing the
   folder) is closed by the same-scope rule alone.
7. **Message text is peer text, never the user's.** It reaches a recipient
   only as a tool result marked "written by another agent tab, not the user".
   Tabtivity never types message text, a sender's label or anything else an
   agent chose into a prompt (the git lane's rule: an outcome must not become
   a prompt). What may reach a prompt is one fixed, host-built English
   sentence (`tabs_mcp::NOTICE`, no `'`, never starts with `/ ! # $ @`):
   - *Hook hint*: at `tabs_send` the host leaves `<live_dir>/<uid>.mail` for
     the recipient (found by its PTY id as `agent_turn::note_input_from`
     finds `<uid>.from`, written no-follow through `home_io` because the
     directory is agent-writable; the file is empty). The agent hook prints the hint beside
     the next `UserPromptSubmit` and removes the marker, as it does
     `NAME_HINT`. Claude only until another CLI's hook output is verified. A
     forged or deleted marker costs a spurious or missed hint, nothing else.
   - *Deliver button*: the user's own click queues `NOTICE` for the tab
     through `queuePromptForTab` (the scheduler's idle gate; never
     `whileBusy`, never onto a decision prompt).
   Tabtivity may also do that by itself only under the per-project wake opt-in (decision 1, step 7).
8. **Text and caps.** `text` 1–4,000 characters (counted in characters),
   newlines and tabs allowed, other control and invisible/bidi characters
   refused (`strip_invisible` rule). 20 unread per recipient (`inbox_full`),
   200 messages per scope, 2,000 per process; life 24 h. Budget per saved tab
   id (a respawn does not reset it), rolling hour, `admit_keyed`: 30 sends,
   120 `tabs_list` + `tabs_inbox` calls; taken after validation.
9. **Refusals** are normal results `{status: "refused", category, message}`:
   `invalid`, `too_large`, `not_found`, `self`, `inbox_full`, `budget`
   (+ `retryAfterSecs`), `off`, `unavailable`. Switched off, a running tab
   still answers `initialize`/`tools/list` and calls say `off`. Audit rows:
   session, tool, category; never text, labels or handles.
10. **State** is in memory in the granting process (decision 3), like
    markup asks and print requests; tokens die with the process anyway. A tab
    restart or resume keeps its inbox and handle (same saved tab id, new
    token; `register` revokes the old one). A closed tab stops being listed at
    its PTY exit; what waited for it expires. App quit drops everything.
11. **Window only in v1.** `Runtime::serves_tabs()` = the window
    (`serves_root && serves_web`, as print): the Mobile host and a server
    daemon grant nothing, so no traffic exists that the window cannot show.
    Tabs the phone creates headless are not reachable (known limit).
12. **The user reads everything.** The window lists a scope's messages
    (sender, recipient, time, full text) as plain React text marked as written
    by the agent; no links, no markdown. Class `client` commands; nothing
    crosses `mobile_control` (phone: out of scope).
13. **Cross-OS.** Loopback HTTP + env pair, so the Linux fence, macOS Seatbelt
    and Windows (no fence) behave alike; the hook hint has its PowerShell
    twin. On Windows isolation is the token alone (the inherited limit in
    `agent_schedule_mcp.md`: every process a tab starts holds its tokens).
    Cut network exists on Linux only.

## Decisions (user, 2026-11-14)

All seven open decisions took the recommendation; they are fixed like the
section above.

1. **Idle recipient:** hint + Deliver button; automatic idle wake is a
   separate per-project opt-in, off by default (step 7 is in scope): one wake
   per unread batch, 6 per tab per hour, claimed on the host.
2. **Classes never mix**, in locked and unlocked projects alike.
3. **In memory, per process, 24 h.** Nothing on disk.
4. **One global switch** in Manage CLIs → Tabtivity tools, on when absent.
   (The step-7 wake switch is per project and separate.)
5. **Box tabs out** in v1.
6. **Cut-network tabs out** in v1 (no grant; the relay refuses `/mcp/tabs`).
7. **Visibility:** a Messages fold in the cockpit detail pane plus an unread
   line on the tab hover card. No tab pill, no project-wide view.

## Steps

Each step ends with its gates (`scripts/gates-job.sh start`), `git diff
--check`, and `npm run backend:stale` after backend edits. Never start or
restart the app.

1. **Service core** — `src-tauri/src/services/mcp/tabs_mcp.rs` (new):
   constants, `tools()`, `INSTRUCTIONS`, `NOTICE`, `Binding { cockpit binding,
   class }`, handle key and `handle_of`, `may_exchange`, the store
   (`Mutex`, `prune_at(now)`), budgets, validators, `handle_with(session,
   message, ctx)` taking the registry reader and clock as parameters,
   `purge_scope`, `sweep`, `set_change_hook`, `traffic(scope)` for the window.
   Export in `src-tauri/src/services/mcp/mod.rs` and
   `src-tauri/src/services/mod.rs`.
2. **Lane wiring** — `src-tauri/src/services/root_mcp.rs`: `TABS_*_ENV`,
   `LANE_TOKEN_ENVS`, `Caller::Tabs` in every `match` (lane index, server
   name, the "fixed at spawn" lists), `Runtime::serves_tabs`,
   `apply_tabs_to_spawn_with` (Vibe merge + `wire_named_cli`), `grant_tabs`
   (binding, class, register, stamp the binding on the session) called last
   in `grant_lanes` under `project_lanes && serves_tabs && settings.tabs_mcp()`
   and not for a cut spawn. Confirm `opts.local_model` and the stamp are final
   at `grant_lanes` (`launch_prep.rs` ~1110, home prepared ~1485); if not,
   stamp the class later as `stamp_push_fence_scope` does.
   `src-tauri/src/services/root_mcp/root_mcp_security.rs` (positive tool
   policy, `serves`), `root_mcp/root_mcp_mail.rs` (caller name),
   `src-tauri/src/commands/root_mcp.rs` (route, `path_serves`, dispatch),
   `src-tauri/src/schema/settings.rs` (`tabs_mcp`, absent = on).
3. **Secret carriers and exit** — `src-tauri/src/services/tmux_local.rs`
   (`SECRET_ENV`), `src-tauri/src/services/sandbox.rs`
   (`is_secret_exec_env`), `src-tauri/src/services/launch_prep.rs` (control
   env list), `src-tauri/src/terminal/mod.rs` (PTY exit: revoke + `sweep`).
4. **Privacy seams** — `src-tauri/src/commands/agent_privacy.rs` (purge on
   flip), `src-tauri/src/services/local_lane/policy.rs` (no change; extend the
   refusal test in `local_lane/tests.rs` to name `/mcp/tabs`).
5. **Hint and the generic client** —
   `src-tauri/src/services/agent/agent_session.rs` (sh and PowerShell hook
   twins: `.mail` marker → `NOTICE`, gated on the lane's URL variable);
   `src-tauri/src/services/agent/agent_turn.rs` (`note_mail(pty_id)`, the
   marker write, modelled on `note_input_from`); `scripts/tabtivity-mcp.sh`
   and `scripts/tabtivity-mcp.ps1` (`tabs` in the lane list);
   `src-tauri/src/services/agent/agent_hint.rs` (`tools_hint!` names the new
   capability).
6. **Window surface** — `src-tauri/src/commands/tabs_mcp.rs` (new):
   `tabs_mcp_traffic({scope, tabId?})`, `tabs_mcp_deliver({scope, tabId})` →
   the host's `NOTICE` + the tab's schedule target (the window queues it),
   `tabs_mcp_clear({scope})`; change hook emitting `tabs-mcp-changed`. Rows in
   `src-tauri/src/services/command_class.rs` (`client`), registration in
   `src-tauri/src/lib.rs` and `commands/mod.rs`, regenerate
   `src/lib/transport/commandClasses.ts`. Frontend, all new unless noted:
   `src/lib/window/tabsMcp.ts`, `src/stores/tabMessages.ts` (through
   `subscribeTauri`, gated on `PaneVisibleContext`, catch up on show),
   `src/components/cockpit/CockpitMessages.tsx` mounted in the existing
   `CockpitDetail.tsx`, one line in the existing
   `src/components/tabs/TabHoverCard.tsx`,
   `src/components/agents/TabsMcpSettings.tsx` in the existing
   `AppToolsSettings.tsx`, `src/types/index.ts` (`tabs_mcp`), i18n keys
   `tabsMcp.*` in `src/lib/i18n/en.ts` and the four other dictionaries,
   `src/lib/untested.ts` rows `tabs.mcp.lane`, `tabs.mcp.traffic`,
   `tabs.mcp.deliver`. Surfaces follow the add-menu skill's shared frames.
7. **Idle wake (decision 1: in scope, per-project opt-in, off by default)** — `projects.json`
   `tab_messages_wake` through `project_registry::patch_project_entry`, a
   `client` setter command, host-side claim `tabs_mcp_wake_claim` (opt-in
   re-read, one per batch, 6/h), a `TabMessagesHost` in
   `src/components/layout/AppShell.tsx` beside `AgentScheduleHost` that only
   queues what the claim returns. Untested id `tabs.mcp.wake`.
8. **Docs and register** — new `docs/context/tab_messaging_mcp.md`; one row
   each in `docs/filemap_backend.md` / `docs/filemap_frontend.md`; lane list
   in `docs/context/agent_mcp_wiring.md`; a paragraph in
   `docs/context/local_models_only.md`; `docs/help/agent-clis.md`; manual-QA
   boxes in `todo/group-s-agents.md`.

## Tests

Rust (paths by `Path::join`, no absolute literals, no spawned programs):

- `tabs_mcp`: `may_exchange` as a table; send → inbox → ack; read twice
  without ack returns the same; unknown / other-project / other-class handle
  give the identical `not_found`; `self`; character (not byte) bounds with
  non-Latin text; invisible and bidi refused; `inbox_full`; budgets with
  `retryAfterSecs`, surviving a re-grant; `prune_at` at 24 h; a re-grant keeps
  inbox and handle; `purge_scope`; a message whose class no longer matches is
  not returned; locked project + unstamped caller and unreadable registry →
  `unavailable`; `off` with `tools/list` still answering; every reply
  serialized contains no scope id, tab id, uid or path.
- `root_mcp/tests.rs`: grant matrix for every row of decision 5 (assistant,
  root, Host session, reader VM, container, remote, worker, VM, `local_only`,
  box, cut, attach-only, no saved tab, Mobile-host runtime get none); the four
  `McpWiring` forms and the Vibe merge name the server; `LANE_TOKEN_ENVS` scan.
- `commands/root_mcp.rs`: a Tabs token is admitted on `/mcp/tabs` only; no
  other caller is admitted there.
- `local_lane/tests.rs`: the relay refuses `/mcp/tabs`.
- `agent_session` tests: both hook twins carry the marker block; `NOTICE`
  holds no `'`. `tmux_local` secret slot; `command_class` TS is current.

Frontend (vitest): the fold renders markup-looking text literally; Deliver
queues exactly the host's string through `queuePromptForTab`; no listing while
the pane is hidden; the settings switch round-trips; pills present.

## Manual verification (user-run, after loading a build with this backend)

1. Manage CLIs → Tabtivity tools: "Let agent tabs of a project message each
   other" is on. Open two fresh Claude tabs and one Codex tab in a local
   project.
2. In tab A: "list the other tabs and send the Codex tab 'ping'". The cockpit
   detail pane of the Codex tab shows the message under Messages, unread.
3. Press Deliver: once the Codex tab is idle the notice appears as its prompt
   and it reads the message. Type a prompt into the third tab after sending it
   one: the hint appears beside your prompt (Claude).
4. In a second project, ask an agent to send to a handle copied from the
   first: `not_found`.
5. Open Tabby and a root console agent: neither lists the tools.
6. Mark the project Local models only: its mailbox empties, cloud tabs close;
   two local tabs can message each other. In an unlocked project a
   local-model tab and a Claude tab do not list each other (decision 2).
7. Restart one tab: its unread is still there. Turn the switch off: a send
   answers `off`.
8. Repeat 1–3 on macOS and Windows where available; tick only what was run.

## Organisation

**Shape (user's choice, 2026-11-14):** two Opus implementers in series, then
one separate Opus reviewer. This replaces the parallel-track shape drafted
earlier. All work sits on one branch based on `develop`'s HEAD; the main agent
cherry-picks onto `develop`. Handoff file: `docs/done/tab_messaging_mcp_handoff.md`.

| Agent | Plan steps | Main files |
|---|---|---|
| I1 Backend lane **sec** | 1, 2, 3, 4, 5 | `services/mcp/tabs_mcp.rs` (new), `services/root_mcp.rs` (+ `root_mcp_security.rs`, `root_mcp_mail.rs`), `commands/root_mcp.rs`, `schema/settings.rs`, `tmux_local.rs`, `sandbox.rs`, `launch_prep.rs`, `terminal/mod.rs`, `commands/agent_privacy.rs`, `local_lane/tests.rs`, `agent_session.rs`, `agent_turn.rs`, `agent_hint.rs`, `scripts/tabtivity-mcp.{sh,ps1}` |
| I2 Window + wake + docs | 6, 7, 8 | `commands/tabs_mcp.rs` (new), `command_class.rs` + generated TS, `lib.rs`, the new frontend files, `CockpitDetail.tsx`, `TabHoverCard.tsx`, `AppToolsSettings.tsx`, `AppShell.tsx`, i18n ×5, `untested.ts`, docs |
| R Reviewer | all | the whole range, against this plan and AGENTS.md invariants |

Each implementer commits in plan-step units, each commit green on the gates it
touches. If either runs low on context, it stops at a green commit and writes
the handoff; a fresh agent continues. The reviewer gets the plan and the diff,
not the implementers' summaries. It fixes confirmed bugs only, each with a
regression test, and puts design objections under "Flagged for user" in the
handoff. Its checks cover the seams too: Rust ⇄ TS shapes, command classes,
i18n keys, the untested register, `scripts/brand-check.sh`,
`scripts/privacy-check.sh`.
