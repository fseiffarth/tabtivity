# AI switch: one power button that stops new AI use

*Status: built 2026-10-20 (uncommitted), never run live. Deviations from
the first draft are marked **(as built)**.*

## Why

The user wants one click that stops all of Tabtivity's AI use, and a second
click that brings it back. Today AI starts from many places: agent tabs and
their typed prompts, Tabby, timed prompts (schedules, auto-continue, warm-up
cron), the phone, editor autocomplete (Ollama, Copilot) and mail AI. There is
no single place to stop all of it.

## Fixed decisions (user, 2026-10-20 — not up for review)

1. **Running agents keep running.** Switching AI off does not freeze or end
   any process. It blocks **new** AI work: typing or sending a prompt to an
   agent tab, launching an agent, timed prompts, completions, mail AI.
2. **The off state persists.** It lives in `settings.json` and survives a
   restart. While AI is off, a restored agent tab does not spawn. It shows an
   "AI is off" note instead and starts when AI is switched back on.
3. **Machine-wide, phone included.** The Mobile sidecar refuses phone typing,
   prompt sends and launches to agents, and its scheduler skips due prompts.
   The phone shows "AI is off" but has no switch of its own.
4. **Placement:** a power button in the side panel header chrome, next to the
   hide chevron and the side flip (`SidePanel.tsx`'s `chrome`, passed into
   `ProjectFilesView` through the `pin` slot). It shows in every scope (project, box, root),
   but not in Files (Project) tabs. While AI is off, the button is lit in red.

## Decisions made while planning (mine; change if wrong)

- **Name and storage.** The setting is `ai_off: bool` in `settings.json`;
  unset means AI is on. A new AppHandle-free service, `services::ai_switch`,
  provides `is_off(state_dir)` (an mtime-keyed cache, so a check per
  keystroke costs one `stat`), `set(state_dir, off)` (through
  `patch_settings`) and the fixed refusal token `AI_OFF = "ai_off"`. The
  window and the sidecar read the same file, so both obey the same switch
  with no extra protocol.
- **No new commands (as built).** The switch is an ordinary settings patch
  (`updateSettings({ ai_off })`), which `app:settings-changed` already
  carries to every window and popout. `lib/aiSwitch.ts` reads it from the
  settings store.
- **What counts as an AI target** is decided by the backend, not the
  renderer:
  - **PTYs:** `agent_fence::is_agent(&opts)` (or an assistant launch) at
    spawn time, recorded on `PtyEntry` as `agent: bool`.
  - **A shell tab running a CLI:** the `agent_shim` refuses to start a CLI
    while AI is off and prints one line saying why. A CLI already running
    inside a shell tab is left alone (decision 1), and so is typing into that
    shell tab: a shell is not an agent target.
- **Loading an Ollama model** is refused while off (`run_load`, so both the
  window and the phone; the phone's `start` too). `unload` is still allowed.
- **Typing that still passes (as built):** Ctrl+C, and escape sequences with
  no Enter and no paste (Esc, arrows, focus/mouse reports, the terminal's
  answers to the program), so a running agent can always be stopped
  (`ai_switch::filter_while_off`).
- **File drops (as built)** still copy the file; the path typed afterwards
  is input and is refused.
- **What stays allowed while off:**
  - Reading transcripts and chat history.
  - Model list and delete, and Manage CLIs.
  - Sign-in flows.
  - The API proxy and the web lane, because they only serve agents that are
    already running (decision 1).
  - Tab close and kill.
- **What the user sees:**
  - **The switch.** The power icon (⏻, an SVG in the header icon-button
    family) has the tooltip "AI is on — click to switch all AI off" /
    "AI is off — click to switch it back on".
  - **Typing into an agent tab while off.** The keystroke is dropped, and the
    tab shows a one-line note, "AI is off — switch it on in the side panel"
    (at most once every few seconds, not per keystroke).
  - **Off-only features.** The completion providers simply return nothing.
    The mail AI buttons are disabled with the same tooltip.
- **Not covered:** a server daemon's web clients. The server version
  inherits the switch through `core` and the shared settings file, but a
  daemon-side UI is out of scope.

## As built: review fixes and known limits

Three independent reviewers read the build (2026-10-20). What they found and
was fixed:

- **Spawn retry.** A refused retry waits again instead of failing the tab.
  This covers the store being ahead of the file, and a switch in another
  window.
- **Waiter cleanup.** The waiter ends with its pane (`AbortSignal`).
- **Phone delivery.** A dropped phone prompt is marked Not delivered, not
  sent: the bridge sends `ai_off` before the ack.
- **Allowlisted keys.** Only an allowlist of keys passes. Keypad Enter,
  kitty/modifyOtherKeys Enter, Shift+Tab and Alt+key are refused. A Ctrl+C
  batched with text still goes in, alone.
- **Reattach after restart.** A tab whose agent still runs in its local tmux
  session reattaches while off, so it can be stopped. Its input stays gated.
- **Sign-in allowed.** Sign-in launches (`<cli> login`, `<cli> auth login`)
  are not AI spawns, so sign-in keeps working.
- **Warm-up gated.** `agent_warmup` checks the switch in the backend too.
- **Phone routes gated.** These answer `403 ai_off`:
  - agent `create_tab`
  - `sent_prompt`
  - `hold_prompt` and `edit_held_prompt`
  - `markup_answer`
- **Phone untested marker.** The phone's notices carry the `mobile.aiOff`
  untested row.

Closed in a second round:

- **Reopen and Activate.** The phone's Reopen (only agent tabs are kept) and
  Activate (when it would start a chat) answer `403 ai_off`. A headless
  spawn refused by the switch also answers `ai_off`, not `launch_failed`.
- **Phone composer.** On an agent tab the composer keeps its draft and sends
  nothing while AI is off. The terminal socket says when the switch changes
  (`ai_switch { off }`, checked on the bridge's 1 s tick and sent at open
  while off), and the notice stays up for as long as AI is off.
  `/api/v1/status` carries `ai_off` too.
- **Remote reattach.** Remote agent tabs reattach too: before refusing, the
  spawn asks the host for `tmux has-session` over the shared master
  (`BatchMode`, so no prompt). An unreachable host reads as "would start".

Known limits, left as they are:

- **Sessions-view attach.** A Sessions-view attach onto a hand-started tmux
  session is not classified as AI. Neither is a CLI typed into a remote,
  container or VM shell, since only local shells have the shim. These are the
  fence's own limits.
- **Unreadable settings file.** An unreadable `settings.json` reads as AI on.
- **No-op note.** The "AI is off" note is a pill that stays up while off, not
  the throttled note first planned.

## Steps

1. **Backend switch.** Gates: cargo test, both clippies, the daemon build.
   - `src-tauri/src/services/ai_switch.rs`: `is_off`, `set`, `AI_OFF`, unit
     tests for an unset key, a toggle, an unreadable `settings.json` (reads
     as on, the same default `load_settings` gives every other key) and the
     cache invalidating on mtime.
   - The `ai_off` field in `settings.rs`, round-tripped.
   - (as built: no commands — see "No new commands".)
2. **Backend gates, desktop.** Each gate gets a unit test where its module
   already has tests.
   - **`pty_spawn`:** after `launch_prep::prepare`, refuse an agent spawn
     with `AI_OFF`.
   - **`pty_write`:** refuse writes to an `agent` entry. This needs the
     `agent` flag recorded on `PtyEntry` (`terminal/mod.rs`) and on its
     attach PTYs.
   - **`pty_drop_files`:** left as is (as built — see "File drops").
   - **Completions:** `copilot_complete` and `ollama::complete_text` return an
     empty result.
   - **Mail AI:** `mail_ai::chat` and `classify` return `AI_OFF`. Classify on
     sync skips quietly.
   - **Tabby:** `assistant_new_chat` is refused.
   - **The shim:** `agent_shim` prints a line and exits with a nonzero code.
3. **Backend gates, sidecar** (`services/mobile_control/`). Gates:
   `mobile_control` tests.
   - `pty_bridge.rs` drops input frames to an agent tab and sends a single
     `ai_off` notice frame.
   - The prompt `send` route and the tab launch/reopen routes refuse with
     403 `ai_off`.
   - The `scheduler.rs` tick skips (rules stay due, not consumed).
   - `local_models.rs` handles `load`/`start` as described above.
   - The catalog/status reply carries `ai_off: true`.
4. **Desktop UI.** Gates: `npm run build`, `npm test`, `npm run lint`.
   - **Store:** `lib/aiSwitch.ts` over the settings store (as built).
   - **Button:** in `layout/SidePanel.tsx`'s `chrome`, with an `UntestedTag`
     plus its row in `lib/untested.ts`.
   - **Timed prompts:** `AgentScheduleHost`, `AgentContinueHost` and
     `AgentCronHost` return early while off. They are not consumed, so a due
     prompt fires after the switch goes back on.
   - **Terminals:** `TerminalView.tsx` skips spawning an agent tab while off
     (it shows the note) and spawns when the store flips back on.
     `lib/terminal/terminalInput.ts` drops agent input and shows the note.
   - **Completion providers** short-circuit.
   - **Mail AI buttons** are disabled.
   - **Strings:** the new keys go in `i18n.ts` and the de/es/fr/it dicts.
   - **Tests:** the store, the button toggle and its aria-pressed state, and
     a terminal that defers its spawn.
5. **Phone UI** (`mobile-web/`). Gates: `npm run build`, `npm run
   mobile:bundle`.
   - An "AI is off" banner from the `ai_off` flag.
   - The composer is disabled with the same words.
   - Phone i18n keys.
6. **Docs.**
   - Rows in `filemap_backend.md` and `filemap_frontend.md` (one line each).
   - A short section in the matching `docs/help/` page.
   - A `todo/` 🖐️ box with the per-platform ✅/❌ pairs.

## Organisation

Main loop, sequential steps 1 → 6 (no subagents were asked for). It is about
two days of work, and every step leans on the switch added in step 1.

## Verification

- Run `scripts/gates.sh` for the touched gates. Then run `npm run
  backend:stale` and report its result. Never run the app live.
- Click-through for the user:
  1. Click ⏻ on the edge rail. Typing into an agent tab does nothing and
     shows the note, and a new agent tab shows the note instead of starting.
  2. The phone shows the banner and refuses a prompt.
  3. Restart Tabtivity. AI is still off.
  4. Click ⏻ again. Waiting tabs start, and typed input reaches the agent.
