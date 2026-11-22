# Stop idle agent tabs, resume them when shown — plan

> **Status (screened against code 2026-11-22):** Implemented: `lib/agents/agentTabStop.ts` (policy), `stores/agents/agentTabStop.ts` (`stopAgentTab`), `components/layout/AgentTabStopHost.tsx`, settings `stop_agent_tabs_cap`/`_idle_min`/`_min_free_mb`, `services::agent_resume_pinned`. Differs from the plan: CLIs are stopped only while their tab's own conversation is pinned (see `docs/context/agent_sessions.md`, "Stopped tabs", the current description). Live verification (section 12) is open. Not live-tested.

Base `7cc15e858` (2026-11-18); decisions at the end.
Why: ~210 agent tabs, each live `claude` 0.35–0.45 GB (~50 GiB), systemd-oomd
killing apps. "Unload hidden tabs after" (`sleep_tabs_after_min`) frees only
the xterm; the agent process keeps running. This feature ends the process,
keeps the tab, and respawns it with the CLI's resume when it is needed again —
what a restart already does for every resumable tab, done per tab.

All line numbers are against `7cc15e858`.

## 1. Finding: restored agent tabs spawn eagerly, shown or not

Yes — every restorable agent tab of every **active** project spawns at launch:

1. `stores/projects.ts:1600` — `whenSettingsLoaded().then(() => restoreActiveProjectScopes())`.
2. `stores/projects.ts:1391` `restoreActiveProjectScopes` → `restoreProjectScope`
   (`:1279`) → `hydrateScopeFromDisk` (`stores/tabs.ts:4213`) →
   `loadFromLayout` (`stores/tabs.ts:3810`) for every project with
   `status === "active"`, not just the current one (doc comment `:1370-1389`
   says this is deliberate: "a relaunch came back with only the current
   project running … which is what this pass fixes").
3. The restored entry is built in `stores/tabs/tabEntries.ts:160-300` with
   `args = resumeArgsOf(tabShape)` (`:184`) and a `tmuxSession` name minted if
   missing (`:243-247`).
4. `components/layout/CenterPanel.tsx:1022-1032` (`allTabs`) renders a
   `PaneSlot` (`:1221`) for **every tab of every loaded, non-inactive scope**,
   hidden ones with `display: none`.
5. `PaneSlot.tsx:268` → `TabPane` → `TerminalView`, whose mount effect
   (`TerminalView.tsx` effect ending `:2437`) calls `pty_spawn` (`:1869`)
   whether or not the pane was ever shown (`filemap_frontend.md` row for
   `TerminalView.tsx`: "the PTY spawned at mount regardless").
6. The only thing that ever unmounts it is the sleep (`PaneSlot.tsx:241-264`),
   and that parks the PTY rather than killing it (`TerminalView.tsx:2359-2387`).

So 210 restored tabs = 210 `pty_spawn`s = 210 agents (and, for Mobile-access
scopes, 210 tmux clients). Restore must therefore create **Stopped** tabs past
the cap (§6).

## 2. States

`TabEntry.stopped?: boolean` — **runtime only** (like `hostSessionPaused`,
`types.ts:458`): never in `toSavedTabEntry` (`stores/tabs.ts:339`), stripped
by `duplicateSpec` (`tabEntries.ts:85`) and by the closed-tab record
(`stores/agents/closedAgentTabs.ts:154`, where `hostSessionPaused` is already
stripped).

| State | Process | tmux session | Pane |
| --- | --- | --- | --- |
| Live | running | alive (if wrapped) | `TabPane` / `TerminalView` |
| Asleep (existing) | running | alive | `SleepingPane`, PTY parked |
| **Stopped** (new) | none | killed, launcher removed | `StoppedPane`, no `TerminalView` |

`TabEntry.lastUsedAt?: number` — **persisted** (epoch ms), so restore can rank
by least-recently-used. Passes through the backend untouched (unknown tab
fields ride `TabEntry.extra`, `src-tauri/src/schema/session.rs:37`; compare
`autoContinue`, which has no Rust mention). Validate on the way in
(`tabEntries.ts`, finite number, not in the future + 1 day). Written coarsely
(only when it moves ≥ 10 min) so it does not churn the save debounce.

## 3. Stop path (one tab)

`stopAgentTab(scope, key)` in a new `src/stores/agents/agentTabStop.ts`:

1. Re-check guards (§5) on the tab as it is now; bail if any holds.
2. `set stopped: true` through a new tabs-store action
   (`setTabStopped(scope, key, on)`, a `writeScope` like
   `relaunchTabInScope`, `stores/tabs.ts:2081`).
3. `PaneSlot` renders `StoppedPane` for a stopped tab (new branch **before**
   the sleep branch, `PaneSlot.tsx:241-264`; never `markPtyAsleep` a stopped
   tab). The unmounting `TerminalView` hits its normal kill branch
   `TerminalView.tsx:2388` → `pty_kill` (`commands/terminal.rs:661`, teardown
   reaps the subtree). If the pane was already **asleep**, add an effect in
   `PaneSlot`: `if (stopped && ptyId) killAsleepPty(ptyId)`
   (`lib/terminal/sleepingPtys.ts` `killAsleepPty`).
4. Then `invoke("local_tmux_kill", { session })` for the tab's own minted
   session — `mintedLocalSessionOf(scope, tab)` (`lib/remote/closeRemoteTab.ts:103`),
   never a `tmuxAttach`. `local_tmux_kill` (`commands/terminal.rs:232`) →
   `SessionMux::kill` (`services/session_mux/tmux.rs:497`): walks the pane's
   subtree, `kill-session`, then `tmux_local::remove_launcher`
   (`services/tmux_local.rs:967`, `<state_dir>/tmux-launch/<session>.sh`), and
   drops the session's API-proxy tokens. Idempotent for a session that is not
   there — so calling it for an unwrapped tab is harmless. **No backend change
   needed for the kill.** Windows session host: the same command goes to
   `services/session_mux/winhost.rs:476` — shared path.
5. Note the stop (ptyId → stoppedAt) for the anti-thrash grace and the report.

Same order as `relaunch` in `stores/agents/agentClearUndo.ts:149-165` (kill the
minted session, never an attach), except it does not respawn.

## 4. Wake path (one tab)

`wakeAgentTab(scope, key)` in the same store:

```
relaunchTabInScope(scope, key, resumeArgsOf(tab), { stopped: false, initialInput: undefined })
```

- Widen `relaunchTabInScope`'s `patch` type (`stores/tabs.ts:604`) to allow
  `stopped` and `initialInput`.
- `resumeArgsOf` (`stores/tabs/tabKinds.ts:342`) is the restore's args:
  Claude `--resume <sessionId>`, Codex `[]` (the backend injects
  `codex resume <live-id>`). The backend then resolves the *current*
  conversation: `resolve_claude_session` (`services/agent/agent_session.rs:293`,
  follows `/clear` via the live record; with no log it downgrades `--resume`
  to `--session-id`, i.e. fresh, never an error) and `resolve_codex_session`
  (`:162`, record → `codex resume <id>`, none → fresh).
- The new `TerminalView` mounts and spawns (`:1869`) with the tab's persisted
  `tmuxSession`; `new-session -A` creates a fresh session running the resume.
  `initialInput` is cleared so nothing is retyped (it is also guarded per PTY
  by `claimInitialInput`, `lib/terminal/terminalControl.ts:142`, belt and
  braces).
- Record `wokenAt` for the grace.

`ensureAgentTabAwake(scheduleTargetId, timeoutMs = 60_000): Promise<boolean>` —
wakes if stopped, then waits until `scheduledAgentInput(id)?.ready()`
(`lib/agents/scheduledAgentInput.ts:113`) or times out. For callers that type
into a tab off screen.

### Wake triggers

| Trigger | Where |
| --- | --- |
| Tab shown (visible, in a popout, drawn by the cockpit/console/dock) | `PaneSlot`: `useLayoutEffect` — `if (tab.stopped && (visible \|\| inPopout \|\| drawnElsewhere)) wakeAgentTab(...)`. Typing and the Chat view need the tab on screen, so they are covered by this. |
| Scheduled prompt due | `AgentScheduleHost.tsx:491` — the `!input` branch (no registration because nothing is mounted): if `binding.tab.stopped` and the verdict is due, `wakeAgentTab` and `break`; the next tick delivers through the existing gate (`idleForDelivery`, `agentDeliveryReady`). Also covers phone sends and phone holds (they are send-now schedule rules, `lib/agents/phoneHolds.ts`) and tab-messaging's idle wake (`TabMessagesHost.tsx` → `queuePromptForTab` → schedule rule). |
| Phone opens the tab | `MobileBridgeHost.tsx:1374` `wrapAgentTabForPhone` (reached from `activate`, `:1334`): first line, `if (tab.stopped) { wakeAgentTab(...); return null; }`. The phone already polls the catalog until the row is `available` (`mobile-web/src/screens/Project.tsx:565-582`), which it becomes once the new tmux session exists. A stopped tab reads `available: false` (no session), so the phone shows its existing "start" affordance. |
| Auto-continue fire | `AgentContinueHost.tsx:180-193`: never stop an `autoContinue` tab (guard), so no wake needed. |
| Steering submit to an off-screen tab | `lib/shortcuts/steeringAgent.ts:83` and its `submitScheduledAgentMessage` call: `await ensureAgentTabAwake(...)` first. |
| `tabs_send` | Left queued until a wake (user's call); with the project's idle wake on it wakes through the scheduler (row 2). |

## 5. Guards (never stop while any holds)

All read in one pure function, `stopBlockers(tab, signals): StopBlocker[]`
(`src/lib/agents/agentTabStop.ts`), so tests and the UI can say why.

| Guard | Signal | Cost |
| --- | --- | --- |
| Turn in flight / settling | `agentDeliveryReady(ptyId, STABLE_MS)` (`stores/activity.ts:609`) false — covers working, decision, a keystroke awaiting its hook verdict (20 s grace), and a **background shell still running** (`turn.job`). Also `busyByTab[ptyId]` for hookless CLIs. | free |
| Decision / permission prompt | `attentionByTab[ptyId] === "decision"` (`activity.ts:1340`) | free |
| Agent asked via `tab_request_attention` | `currentAttention(tab.cockpitMeta, now)` (`lib/cockpit/agentNotes`, used by `lib/cockpit/decisions.ts`) | free |
| Background work woke recently | `backgroundAtByPty` via `noteBackgroundWork` (`activity.ts:340`); export a reader `lastBackgroundWorkAt(ptyId)`, block if within 10 min | free |
| Subagents running (Claude) | `agent_tab_transcript` with `readerRequest(scope, tab, undefined, undefined, 1)` → `runningAgents > 0` (as `lib/mobileSubagents.ts:30-55`). One IPC per **final** candidate only (≤ 5 per tick). Codex/others: not knowable (backend `running_subagents` is Claude-only). | 1 IPC |
| Queued / held / scheduled-soon prompt | `useAgentSchedulesStore.getState().byTarget[scheduleCacheKey]`: any send-now rule, any `phoneHoldDue(id)` (`lib/agents/phoneHolds.ts`), any `isAgentProposal`, or `nextScheduleOccurrence` (`lib/agents/agentSchedule.ts:170`) within 15 min. Unloaded target → load it (`useAgentSchedulesStore.load`) before deciding. | cache / 1 IPC |
| Visible, popout, cockpit/console/dock drawn | `PaneSlot` reports `shown = visible \|\| inPopout \|\| drawnElsewhere` into a module registry (`noteAgentPaneShown(ptyId, shown)`) | free |
| Phone attached | **Not exactly knowable in the window**: the sidecar's `pty_bridge` holds viewers. Proxy: a `tab_seen` / `tab_input` from the phone (`MobileBridgeHost.tsx:2524`, `:2902`; the bridge sends `tab_seen` at attach, visibility edges and detach, `host.rs:6480-6505`) within the last 15 min → block. Exact state would need a `mobile_attached_sessions` query — follow-up. | free |
| Host session | `tab.hostSession` | free |
| Root console / Tabby | scope `root` or `assistant` → never | free |
| Not local | `!runsLocally(scope, tab)` (`agentClearUndo.ts:142`) → never (remote host tabs out of scope) | free |
| In a container / VM | `tabRunsInContainer(project, kind, scope)` (`lib/projectTabHost.ts`) or `isHostPinned(project)` → never this pass (whether `pty_kill` of the `docker exec` client ends the agent inside the container is unverified) | free |
| CLI resumes only "latest" | allow-list, §5.1 | free |
| No resumable conversation yet | §5.1 | 1 IPC |
| `autoContinue` armed | `tab.autoContinue` | free |
| Print card pending | `usePrintRequestsStore.getState().requests.some(r => r.tab === ptyId)` (`stores/printRequests.ts`, `PrintRequest.tab` is the PTY id, `lib/window/printMcp.ts:30`) | free |
| Markup ask open | `listMarkupQuestions(projectId, scheduleTargetId)` (`lib/viewers/markupQuestions.ts:39`, `markup_mcp_list`) non-empty — final candidates only | 1 IPC |
| Push / release card pending | **Not cheaply knowable**: the backend read runs git (`lib/cockpit/decisions.ts` comment, `pushRequests`). The request lives in the backend and the agent polls `git_push_status`, so a stop does not lose it; leave unguarded and say so. | — |
| Just woken / just spawned | `wokenAt` or first output within 10 min → never (anti-thrash) | free |
| Sign-in, cloud, login, `tmuxAttach` tab | `tab.signIn \|\| tab.cloud \|\| tab.login \|\| tab.tmuxAttach` → never | free |

### 5.1 Which CLIs, and "has a conversation"

From `src/lib/agents/agentCliTable.ts` and `docs/context/agent_sessions.md`:

- **This pass: `claude` and `codex`, kind `agent`, `isResumableAgentTab(tab)`.**
  Both resume a recorded id, never "the folder's latest". Claude is the
  0.35–0.45 GB process the user measured.
- **Never:** `gemini` (`--resume latest`), `cursor-agent`, `grok`, `qwen`,
  `droid` (`--continue`/`--resume` = latest), every `resume: null` CLI, custom
  agents (`resumeArgs` = a continue flag), every `local_agent` tab.
- **Follow-up (not this pass):** `agy`, `vibe`, `opencode`, `copilot`, `muse`
  resume an id **only when their hook record exists**, else fall back to
  `--continue`/`--last`, which can reopen another tab's conversation. They
  need a backend check "would a respawn resume a pinned conversation" (a
  small `agent_tab_resume_pinned` over `read_live_session_for`,
  `agent_session.rs:1577`, plus each CLI's existence check). List them in the
  policy as `PINNED_ONLY` so adding them is one line once that exists.
- "Has a conversation": the final-candidate `agent_tab_transcript` read
  (the subagent row above) must answer `available: true`; otherwise skip. (A
  never-prompted Claude tab would resume fresh without error, but stopping it
  would gain little and is not worth the surprise.) For Codex, also require
  the Codex hook/binder record — `available` comes from the rollout the
  record names, so `available: true` implies it.

## 6. Triggers and the policy

New `src/components/layout/AgentTabStopHost.tsx` (mounted beside
`AgentScheduleHost`/`AgentContinueHost`, main window only, not in popouts),
one sweep every 60 s (30 s while under memory pressure), skipped while
`aiIsOff()` is irrelevant (stopping is fine with AI off).

Pure core in `src/lib/agents/agentTabStop.ts`:

```ts
interface StopCandidate { ptyId: string; scope: string; key: string; lastUsedAt: number; mcpStale?: boolean }
function lastUsedOf(tab, signals): number          // max of: lastShownAt, lastUserInputAt (activity.ts:599),
                                                   // lastDoneByTab, lastWorkingByTab (activity.ts:1358-1364),
                                                   // tab.lastUsedAt (restored), the tab's spawn time
function rankStopCandidates(c: StopCandidate[]): StopCandidate[]   // oldest lastUsedAt first
function pickStops(input: { live: number; candidates; cap; idleMs; now; memLow: boolean; perTick }): StopCandidate[]
```

`rankStopCandidates` is the hook point for the MCP-reattach work in the other
worktree: once `PtySpawned.mcpStale` is recorded per PTY, the host passes it
in and the sort gains one key in front (`mcpStale` first). Never by tab age.

| Trigger | Setting (frontend-read, Rust field only so it round-trips) | Default | Off |
| --- | --- | --- | --- |
| Cap on live agent tabs | `stop_agent_tabs_cap` — choices 10/20/30/50/80 | **30** | `0` |
| Idle time | `stop_agent_tabs_idle_min` — choices 30/60/120/240/480 | **120** (2 h) | `0` |
| Memory pressure | `stop_agent_tabs_min_free_mb` — choices 2048/4096/8192 | **4096** | `0` |

- **Cap:** `live` = agent tabs with a running process (not stopped, any CLI,
  stoppable or not). While `live > cap`, stop the LRU guard-passing
  candidates, at most `perTick = 5` per sweep.
- **Idle:** stop every guard-passing candidate with `now - lastUsedAt > idleMs`,
  at most 5 per sweep.
- **Memory:** read `machine_load_snapshot` (`commands/monitor.rs:114`, already
  used by `rendererWatchdog.ts:345`, `useModelsHub.ts:102`): available =
  `mem_total_bytes - mem_used_bytes` (used is total − MemAvailable on Linux,
  `sysstat.rs:614`; `GlobalMemoryStatusEx` on Windows, `sysstat.rs:2207`;
  macOS through `sysstat`'s macOS arm). `supported: false` → the trigger is
  omitted and its settings row says it is unavailable (never read a missing
  reading as zero). While available < threshold: stop up to 3 LRU candidates
  per 30 s sweep, ignoring the idle time but not the guards. No new backend
  reading.
- Each stop logs one line (console) with the trigger, for the report the user
  will want.

Settings UI: `SettingsPanel.tsx:2113-2133` (the "Unload hidden tabs after"
row) — three `SettingRow` + `Dropdown` rows right below it, each with
`<UntestedTag id="settings.stopAgentTabs" />`. Rust fields next to
`sleep_tabs_after_min` (`src-tauri/src/schema/settings.rs:1053`, with a
round-trip test like `:1867`); TS in `src/types/index.ts:911`. Readers
`stopAgentTabsCap/IdleMs/MinFreeBytes(settings)` in `lib/agents/agentTabStop.ts`
(absent → default, 0 → null), as `sleepTabsAfterMs` does
(`lib/sleepWhenHidden.ts:89`).

### Restore beyond the cap

In `loadFromLayout` (`stores/tabs.ts:3810`; it already reads settings
directly, `:3835`), when the cap trigger is on, every restored tab that passes
the **static** guards (§5: local, CLI allow-list, not root/assistant, not
Host session, not container/VM, not `autoContinue`, not sign-in/attach) comes
back `stopped: true`. Nothing spawns for those (`PaneSlot` renders
`StoppedPane`). Then `AgentTabStopHost`'s first sweep, once
`restoreActiveProjectScopes` has finished (expose its promise or a
`restoreSettled` flag from `stores/projects.ts`), runs a one-off
**restore wake**:

1. List the app's live local sessions with a new command
   `local_tmux_app_sessions() -> Vec<String>` (see §7) and wake every stopped
   tab whose `tmuxSession` is still alive (crash case: the agent is running;
   reattaching is free and it counts toward the cap).
2. Wake the most recently used stopped tabs (by restored `lastUsedAt`) until
   `live === cap`.
3. Visible tabs wake by themselves (`PaneSlot`), scheduled ones through the
   scheduler.

With the cap trigger off, nothing is restored stopped (today's behaviour).

## 7. Backend

Only one new command; everything else exists.

- `local_tmux_app_sessions` in `src-tauri/src/commands/terminal.rs` next to
  `local_tmux_pane_dead` (`:289`): `mux.list()` filtered by
  `tmux_local::sessions_to_reap` (`services/tmux_local.rs:60`, the "minted by
  the app" rule), `Ok(vec![])` with no session backend. Async over a
  blocking body (AGENTS.md: no `.output()` in a sync command).
  `#[cfg_attr(feature = "desktop", tauri::command)]`, register in
  `src-tauri/src/lib.rs` next to `:2489`, a `command_class` row `Core` beside
  `services/command_class.rs:1043-1048`, regenerate
  `src/lib/transport/commandClasses.ts`
  (`UPDATE_COMMAND_CLASSES=1 cargo test -p tabtivity --lib -- the_generated_command_classes_ts_is_current`).
  A Rust test of the filter over a fake `SessionMux` (there is a test mux at
  `session_mux/mod.rs:391`).
- Does **not** touch `root_mcp.rs`, `launch_prep.rs`, `tmux_local.rs` (only
  calls the public `sessions_to_reap`) — the other worktree's files.

## 8. UI marks

- Tab chip: `useTabStateClass` (`components/tabs/TabBar.tsx:194`) adds
  ` stopped`; CSS dims the label and shows a small static glyph (no
  animation; static, so `[data-software-paint]` needs nothing).
- Hover card memory row: `tabCost` (`lib/tabCost.ts:256`) returns
  `{ kind: "terminal", state: "stopped" }` for `tab.stopped`;
  `describeTabCost` (`:295`) → new key `tabCost.terminalStopped`:
  "Stopped — resumes when shown". Shown by `TabHoverCard.tsx:382/539`.
- `StoppedPane` (`components/layout/StoppedPane.tsx`, like `SleepingPane`):
  an empty box (it is never on screen — shown means woken).
- i18n: `src/lib/i18n/en.ts` (settings labels/help next to
  `settings.sleepTabs` `:1736`/`:2605`, `tabCost.terminalStopped` next to
  `:7003`). Check whether a parity test requires de/es/fr/it; add them if so.
- Untested register `src/lib/untested.ts` (next to `settings.sleepTabs`,
  `:436`): `settings.stopAgentTabs` — what to click through (§10).
- Phone: unchanged this pass (a stopped tab is a not-available row the phone
  already offers to start). A "stopped" word in the phone's status would need
  a `protocol.rs` status change — follow-up.

## 9. Docs

- `docs/context/agent_sessions.md`: a "Stopped tabs" section (states, guards,
  the CLI allow-list and why, wake paths, restore).
- `docs/context/tmux_sessions.md`: under "Kill vs. detach", a stop ends the
  local session like a close but keeps the tab.
- `docs/help/settings-and-appearance.md:48` (the "Unload hidden tabs after"
  paragraph): the three new rows. Grep `docs/help/troubleshooting.md` for the
  memory advice and add a line.
- File maps: new rows for `lib/agents/agentTabStop.ts`,
  `stores/agents/agentTabStop.ts`, `components/layout/AgentTabStopHost.tsx`,
  `StoppedPane.tsx`; amend `PaneSlot.tsx` (`filemap_frontend.md:104`),
  `sleepingPtys` (`:657`), the `commands/terminal.rs` row in
  `filemap_backend.md`.

## 10. Tests

Pure (vitest, `src/__tests__/agents/agentTabStop.test.ts`):
- `rankStopCandidates`: oldest `lastUsedAt` first; ties stable; a tab created
  long ago but used recently ranks after one created recently and unused;
  `mcpStale` input ordering (prepared, one assertion).
- `lastUsedOf`: max over shown / input / done / working / restored.
- `stopBlockers`: one case per guard row in §5, plus the CLI allow-list
  (claude, codex yes; gemini, cursor-agent, grok, qwen, droid, agy, vibe,
  opencode, copilot, muse, custom, `local_agent` no).
- `pickStops`: cap (stops `live - cap`, capped per tick, skips blocked),
  idle, memory (ignores idle, caps 3), each trigger off; unsupported memory
  reading → no memory stops.
- Settings readers: absent → default, `0` → off, junk → default.

Component / store (vitest + Testing Library, mocking `invoke`):
- `PaneSlot` + stopped tab: renders `StoppedPane`, no `pty_spawn`; becoming
  stopped while mounted → `pty_kill`; while asleep → `killAsleepPty`;
  becoming visible → `wakeAgentTab` → one `pty_spawn` with `--resume <id>`
  (extend `SleepingTabs.test.tsx` style).
- `stopAgentTab`: `local_tmux_kill` with the minted session, never an attach
  name; refuses when a guard holds at call time.
- `AgentScheduleHost`: a due prompt for a stopped tab wakes it; delivered on a
  later tick once the input registers; not before.
- `wrapAgentTabForPhone`: stopped tab → woken, returns null.
- `loadFromLayout` with cap on: eligible restored agents come back stopped;
  root/Host/Gemini/`autoContinue` ones do not; cap off → none stopped.
- Restore wake: alive tmux sessions woken first, then MRU up to the cap.
- `tabCost` / hover card: stopped → "Stopped — resumes when shown".
- `toSavedTabEntry` keeps `lastUsedAt`, drops `stopped`; restore validates
  `lastUsedAt`.

Rust:
- `local_tmux_app_sessions` filter test (cross-OS: no path literals).
- Settings round-trip for the three fields.

## 11. Implementation steps (ordered, one commit each)

1. **Settings fields** — Rust (`schema/settings.rs`) + TS type + readers in
   `lib/agents/agentTabStop.ts` + tests.
2. **Pure policy** — `lastUsedOf`, `stopBlockers` (static + signal parts),
   `rankStopCandidates`, `pickStops`, CLI allow-list; full unit tests.
3. **Tab state** — `TabEntry.stopped` (runtime) and `lastUsedAt` (persisted,
   validated on restore, stripped by `duplicateSpec`/closed tabs),
   `setTabStopped`, widened `relaunchTabInScope` patch; tests.
4. **Pane** — `StoppedPane`, `PaneSlot` stopped branch (before sleep), kill of
   an asleep PTY, wake on shown, shown-registry reporting, `lastShownAt`
   touches; tests.
5. **Store actions** — `stopAgentTab`, `wakeAgentTab`, `ensureAgentTabAwake`,
   coarse `lastUsedAt` write-back; tests.
6. **Wake hooks** — `AgentScheduleHost` `!input` branch, `wrapAgentTabForPhone`,
   `steeringAgent`; tests.
7. **Backend** — `local_tmux_app_sessions` + command class + regenerated
   `commandClasses.ts` + Rust test; `npm run backend:stale` afterwards.
8. **Host** — `AgentTabStopHost` (sweep, memory read, final-candidate IPC
   checks, logging) mounted beside `AgentScheduleHost`; tests with fake timers.
9. **Restore** — `loadFromLayout` stopped-on-restore + restore-wake pass;
   tests.
10. **UI marks + settings rows + i18n + untested row.**
11. **Docs** — context, help, file maps.
12. Gates: `scripts/gates-job.sh start` (touched gates: build, test, lint,
    cargo test, the clippy variants, brand-check), fix to green.

## 12. Live verification (for the user; never run by an agent)

1. Settings · Power & performance: set the cap to 10, idle to 30 min.
2. Open 12 Claude tabs in one project, send each a one-line prompt, wait for
   each to finish. Within ~1 min the 2 least recently shown carry the stopped
   mark; their hover card memory row says "Stopped — resumes when shown";
   `ps -C claude | wc -l` drops by 2.
3. Click a stopped tab: it respawns, the conversation is there (`--resume`).
4. A tab mid-turn, one with a permission prompt open, and the visible one are
   never stopped.
5. Schedule a prompt (◷) on a stopped tab for 2 min ahead: it wakes and the
   prompt goes in.
6. Mobile-access project: open a stopped tab on the phone — it starts and
   attaches.
7. Quit and relaunch with 30+ restorable agent tabs: only the cap's worth
   spawn (count `claude` processes); the rest show stopped and wake on click.

## Decisions (the user, 2026-11-18)

The open questions, answered:

1. **Defaults:** at most 30 live agent tabs, stop after 2 h idle, and stop
   least-recently-used tabs while free memory is under 4 GiB. Each trigger
   can be switched off in Settings.
2. **Restore:** after a relaunch, only the most recently used tabs, up to the
   cap, come back running. The rest come back Stopped until shown.
3. **Other CLIs now, after the check.** The backend check of §5.1
   (`agent_tab_resume_pinned`) is added for Antigravity, Vibe, OpenCode,
   Copilot and Muse, so a resume can never open the wrong conversation; each
   CLI that passes is stoppable, the others stay always-live. The
   `--continue`-only CLIs (Cursor, Grok, Qwen, Droid, Gemini) are never
   stopped. No uninstalled CLI is run: the check is the backend's own session
   resolution.
4. **Containers:** container agent tabs stay out, never stopped.
