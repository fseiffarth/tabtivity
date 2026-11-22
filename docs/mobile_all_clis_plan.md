# Every desktop CLI on the phone — plan

> **Status (screened against code 2026-11-22):** NOT-STARTED (proposal of 2026-09-27). The gate is unchanged: `MobileBridgeHost.tsx` `agentChoices` still filters on `item.cmd in RESUMABLE_AGENTS` (and custom agents on `resumeArgs`), `tmuxSession.ts` `shouldPersistLocalTab` still requires `resumableAgent`, and `discovery.rs::resumable` still requires a `session_id` plus a registry-resumable bin or resume args. The resumable set is now generated from the registry (`agent_registry::is_resumable_bin`; 12 of the registry's 30 CLIs, `droid` and `muse` added since) and `discovery.rs` no longer holds a hand copy (`BUILTIN` is gone), so step 4's cleanup is partly moot. No `mobile.newTab.allClis` row exists. Not live-tested.
## Today

The phone's ＋ (`NewTabSheet`) lists what the desktop answers to `catalog`
(`MobileBridgeHost.agentChoices`): installed, enabled `AGENT_ITEMS` **that are
in `RESUMABLE_AGENTS`**, plus custom agents with `resumeArgs`. That is 11 of
the desktop's 30 built-ins. Missing: aider, amp, auggie, cline, cn, codebuddy,
crush, goose, junie, kilo, kimi, kiro-cli, mini, muse, openclaw, pi, plandex,
qoder, sweagent.

The filter is not cosmetic. It rests on one assumption, repeated in four places:
**only a resumable agent tab is wrapped in tmux and survives in the layout.**

| Where | What it gates |
|---|---|
| `lib/terminal/tmuxSession.ts` `shouldPersistLocalTab` | tmux wrap: `kind === "agent" && mobileAccess && resumableAgent` |
| `stores/tabs.ts` `isResumableAgentTab` / `isPersistableTab` | whether the tab is written to the layout and restored |
| `services/mobile_control/discovery.rs` `resumable()` | which saved agent tabs the phone lists (a hand copy of `RESUMABLE_AGENTS`) |
| `MobileBridgeHost.agentChoices` | which CLIs the phone may create |

So even a kimi tab started on the desktop never reaches the phone: it has no
tmux session to attach to and no row in the saved layout.

## Change

Split "persisted" from "resumable" for agent tabs in a Mobile-enabled scope:

1. **tmux wrap** — `shouldPersistLocalTab` drops the `resumableAgent`
   condition: any local agent tab in a scope with Mobile access (project or
   box) gets a tmux session. Root stays shell-only.
2. **Layout** — a tmux-wrapped agent tab is persisted even when not resumable.
   It carries its `tmuxSession`, no resume args.
3. **Restore** — on load, a non-resumable agent tab is kept **only if its tmux
   session is still alive** (reattach, same conversation, since tmux kept the
   process). If tmux is gone, it is dropped exactly as today. Nothing ever
   starts a fresh conversation on its own.
   - Needs one liveness probe per such tab at restore (`tmux has-session`),
     done once for the batch.
4. **Discovery** — `resumable()` becomes "resumable **or** tmux-wrapped", so
   the phone lists these tabs. The `BUILTIN` copy should go: accept any agent
   tab with a `tmux_session` that passes `expected_tmux`, which is the real
   gate for attaching.
5. **Catalog** — `agentChoices` drops the `RESUMABLE_AGENTS` filter for
   built-ins, and for custom agents drops the `resumeArgs` requirement (still
   `probe_binaries`-checked).
6. **Phone UI** — a non-resumable tab's card says so (it ends when its tmux
   session does). Keys go in `i18n.ts`, untested pill `mobile.newTab.allClis`.

## Security / invariants check

- Layout lives in `<state_dir>/sessions/<id>/`, not the project folder. The
  restore path adds no argv from the layout: a reattach runs `tmux attach` to a
  name that `expected_tmux` validates, and a dropped tab spawns nothing.
- Fence unchanged: the CLI inside tmux was spawned fenced to begin with.
- "Nothing outlives a clean quit": these tmux sessions already follow the
  shell-tab rule for Mobile scopes (they outlive the window by design, the same
  as resumable agent tabs today). Confirm the quit path treats them the same.

## Tests

- `tmuxSession` unit: agent + mobile, non-resumable → wrapped.
- `tabs` restore: non-resumable with live tmux kept, with dead tmux dropped.
- `discovery.rs`: a non-resumable agent tab with a valid tmux name is listed.
- `MobileBridgeHost`: catalog includes an installed non-resumable CLI.

## Open questions

- Should the desktop's own restore also keep these tabs (step 3) when Mobile
  is **off**? This plan says no: without Mobile they are never tmux-wrapped.
- Aider keeps its own chat history (`--restore-chat-history`). Should it get
  that flag as a "resume" for step 3's dead-tmux case? Out of scope here.
