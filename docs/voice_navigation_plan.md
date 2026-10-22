# Voice navigation: driving Tabtivity by spoken commands

Status: future plan (2026-10-22). Nothing implemented. It starts only after
the desktop voice plan's phase 1 (`docs/desktop_voice_plan.md`, steps 0–4)
has landed and the user has tested it live. This is that plan's step 9.

## Why

The desktop voice plan gives the Chat a microphone, a local recognizer
(whisper.cpp in the backend), a voice that does not hear itself, and
read-aloud. That covers *talking to an agent*. This plan covers *talking to
Tabtivity*: "switch to project Alpha", "new Claude tab", "change the model to
Sonnet", "next waiting", "open mail", "where am I". The aim is to move
through projects, tabs, agents and the mail/calendar/to-do overlays without
the keyboard or mouse.

## Fixed decisions (the user's, 2026-10-22)

1. **Push-to-talk.** A rebindable key starts a command. Hold it and talk; on
   release, the utterance ends. A tap listens until the voice detector
   hears the end of speech. Nothing listens for commands otherwise: there is
   no always-open mic and no wake word in this version.
2. **Commands vs dictation.** An utterance made with the push-to-talk key is
   always a command. While an agent's Chat is dictating (its mic button, or
   hands-free), an utterance is dictation unless it **starts with the
   command word**. Then it goes to the command matcher and never into the
   draft. The command word is an i18n default the user can change in
   Settings → Voice.
3. **Feedback: one short landing line.** After a command the voice says
   where you landed, in one line: "Project Alpha, Claude, waiting for you."
   The full picture comes only on request ("where am I", "what's waiting").
   Anything not understood gets a short "Didn't catch that". The header shows
   what was heard.
4. **Reach: the main window and its overlays.** Projects, boxes and the root
   scope; tabs; agent commands; opening and closing mail, calendar and the
   to-do board. Popout windows and the phone come later (Later, below).

Defaults chosen here (an implementer may not change them; the user may):

- **One command set with keyboard steering.** Voice and steering run the
  same command functions (step 1), so they cannot drift apart.
  Cursor-relative steering keys (`up`/`down`/`left`/`right`, `work`, `back`,
  `press`, `menu`, region search) are not spoken: voice names its target
  ("project Alpha", "tab three", "Claude tab") instead of walking to it.
- **Arguments come only from live lists.** A project, box, tab, agent, model
  or effort named by voice is matched against what exists right now. A
  command never passes free text to a CLI, a path or a setting. The only
  free text voice produces is dictation into a Chat composer, as in the
  desktop plan.
- **Voice never types into a shell.** This is unchanged from the desktop
  plan.
- **Destructive commands ask first.** "Close tab" and "clear conversation"
  open the existing steering confirm box (`steeringConfirm.ts`). Its spoken
  answer is "confirm"/"yes" or "cancel"/"no", heard in one 5 s listen that
  opens without the key because the box just asked. Anything else cancels.
- **Ambiguity asks back.** "Project A…" with two close matches is answered
  with a question ("Alpha or Alpha Two?"), and "one"/"two" or the name
  picks. The option matcher is the one from the desktop plan's step 1.
- **The AI switch ⏻ and every other guard apply unchanged.** A command that
  starts agent use (a new agent tab, a model switch) goes through the same
  path a click does, so whatever blocks the click blocks the command.
- **Push-to-talk borrows the mic.** The backend keeps one `VoiceSession`
  (desktop plan, one listener per machine). While the key is held, the
  window (`owner: Window`) takes the session. A Chat tab's dictation pauses
  and resumes on release, and the utterance is not dictated.
- **Behind `useExperimental`** until it has been tested live.
- **Not an MCP, and no model in the loop.** Utterances are matched
  deterministically in the renderer (step 2). Routing them through an LLM
  calling MCP tools would add seconds per command, need a network or a local
  model, stop working when the AI switch ⏻ is off, and give different
  answers to the same words. An MCP server for these commands would also
  let any agent switch projects, open agent tabs and change models: a new,
  prompt-injectable path to the UI that the agent invariants
  (`docs/context/agent_authority.md`) keep closed. The `AppCommand` registry
  is shaped so its schema could later feed an opt-in, in-process model
  fallback for utterances the matcher misses (Later), still without an MCP
  server.

## The command set (first version)

The words are examples in English; each language has its own phrases
(step 2).

| Area | Spoken | Does |
|---|---|---|
| Projects | "switch to project ‹name›", "project ‹name›", "root", "box ‹name›" | `setActive` on the scope, landing on its tabs as steering's slots do |
| Tabs | "tab ‹n›", "go to ‹tab title›", "next tab", "previous tab" | the scope's tab by position or fuzzy title, via `jumpToTab` |
| Status | "next waiting", "next working", "next done" | `nextDecision` / `nextWorking` / `nextDone` (`statusJump.ts`) |
| New tab | "new ‹agent› tab" (Claude, Codex, Gemini, a custom agent's name), "new shell", "new monitor", optionally "… in project ‹name›" | `requestNewTab`, beside the active tab |
| Close | "close tab" | the confirm box, then `closeTabInScope` |
| Agent | "change the model to ‹model›", "‹agent› model ‹model›" | the active agent tab's `/model <name>` (step 4) |
| Agent | "effort ‹level›" (Claude) | `/effort <level>`, as the Chat's effort chip |
| Agent | "plan", "goal", "clear conversation" | `agentPlan` / `agentGoal` / `agentClear` (clear asks first) |
| Agent | "tell ‹agent› ‹text›", "dictate" | the text into the Chat composer's draft, or the composer's mic on, which the desktop plan's send guard then covers |
| Questions | "one", "option two", an option's words | picks on the open question card in the Reader |
| Apps | "open mail / calendar / to-do", "close" | `openApp` / the overlay's close |
| View | "files", "side panel", "settings" | `files` / `sidePanel` / `settings` |
| Voice | "stop" | stops speech, cancels a pending send |
| Where | "where am I", "what's waiting", "what's working" | spoken summary (step 5) |

"Agent" commands act on the active tab, or on the tab named in the command
("Claude's model …" when exactly one Claude tab is visible). On a tab that is
not an agent, they answer "That tab is not an agent".

## Shape

```
push-to-talk key ─▶ VoiceSession(owner: Window) ─▶ whisper (prompt: live names)
                                                     │ final text
                                                     ▼
                  voiceCommands.match(text, lang, liveLists)
                    │ command + args │ ambiguous │ nothing
                    ▼                ▼           ▼
          appCommands.run(...)   ask back     "Didn't catch that"
          (the same functions steering's keys call)
                    │
                    ▼
          describeLanding() ─▶ TtsEngine (priority: in front of read-aloud)
                           └─▶ header caption: heard → done
```

## Steps

### 0. Prerequisites

- The desktop voice plan's phase 1 (steps 0–4) has landed and been tested
  live: the `VoiceSession` with an `owner` enum, the `TtsEngine` queue, the
  header mic indicator, the option and stop-word matchers.
- Probe how long whisper `small` takes for a short command on the CPU. If a
  2–3 word command takes much over a second, commands use `base` while
  dictation keeps `small` (two contexts; the memory budget is decided then).
- Probe whether `/model <name>` typed with an argument behaves like a pick
  in Claude's picker, which also makes it the default for new sessions.
  Probe it with `CLAUDE_CONFIG_DIR` pointed at a scratch dir, never against
  the user's own config. Record what each CLI does; the spoken confirmation
  (step 4) says so if a switch is sticky.

### 1. One command layer — `src/lib/commands/appCommands.ts`

The steering handlers live inline in `src/hooks/useKeyboard.ts`
(`steerProjects`, `steerPanes`, `steerRegion`), inside the hook's closure,
and take a `KeyboardEvent`. Voice must not synthesize keys, so the absolute
parts move out:

- A registry of `AppCommand { id, args, destructive, available(ctx),
  run(args) }`. `args` is one of: none, scope (project/box/root), tab, agent,
  model, effort, number.
- Each steering action whose meaning does not depend on the cursor becomes a
  call into it: `mail`, `calendar`, `todo`, `newShell`, `newMonitor`,
  `files`, `sidePanel`, `settings`, `popout`, `nextDecision`, `nextWorking`,
  `nextDone`, the slots, `closeTab`, `agentClear`, `agentPlan`, `agentGoal`.
  Steering keeps its own bookkeeping afterwards (entering a region, the
  panel-opened-by-steering flag); the command does only the app change.
- New commands with arguments that steering has no key for: switch to scope
  by id, tab by key, new agent tab by command, set model, set effort.
- `requestNewTab` (`newTabChord.ts`) gains `{ kind: "agent"; cmd }` next to
  the slot form. A slot depends on the agent order and may be unassigned.
  The command offers only enabled, installed agents, and in the root scope
  only those `rootAllowedAgentBins` allows (`newTabItems.ts`).
- Test: every `SteeringAction` is either backed by an `AppCommand` or listed
  in an explicit `NOT_SPOKEN` set, so a new steering action cannot be
  forgotten.
- This is a refactor of working keyboard code. Steering's own tests must
  pass unchanged; it lands as its own commit before any voice code.

### 2. Phrases and the matcher — `src/lib/voice/voiceCommands.ts`

- Phrases are i18n: `voice.cmd.<id>` holds `|`-separated templates with
  slots, e.g. `switch to project {scope}|project {scope}|go to {scope}`.
  English holds every key, then de/es/fr/it. The command word is
  `voice.commandWord`.
- `match(text, lang, lists)` is pure:
  - normalize (case, punctuation, whisper's trailing period, number words to
    digits per language);
  - match the templates;
  - resolve each slot against its live list with `fuzzyRank`
    (`src/lib/fuzzy.ts`).
  - It returns a command, an ambiguity (2–3 candidates), or nothing. A slot
    match counts only above a score floor and clearly ahead of the runner-up.
- Live lists: scope names (projects, boxes, root), the active scope's tab
  titles (`agentTabLabel` for agents), agent names (built-in and custom),
  model names (`agentModelsFor` in `agentPrefaces.ts` plus the tab's own
  `/model` list once the session picker has read it), Claude's efforts
  (`CLAUDE_EFFORTS`).
- Unit tests per language: each template, number words, close names
  ("Alpha" vs "Alpha Two"), whisper-style punctuation, and an utterance
  that is dictation that merely contains a command's words.

### 3. Routing — push-to-talk and the command word

- Shortcut `voiceCommand` in `src/lib/shortcuts/shortcuts.ts`
  (`SHORTCUT_DEFS`), rebindable, hold or tap (decision 1). It works in the
  main window only. In a popout it says "Voice commands work in the main
  window".
- Hold: `voice_listen_start` with `owner: Window`, mode `Command`. On
  release the backend ends the segment at once, without waiting for the
  voice detector's silence. Tap: listen until the voice detector ends it,
  at most 8 s.
- Whisper's initial prompt for a command listen is seeded with the live
  names (step 2's lists, active scope first), capped to whisper's prompt
  budget.
- Inside a dictating Chat: the desktop plan's `ReaderComposer` checks each
  final segment for the command word at its start. If it is there, the rest
  goes to `match`, and the draft is untouched.
- The backend side is one new mode on the existing `VoiceSession`; the
  one-listener rule and the header indicator stay as they are. The indicator
  shows "Command" while push-to-talk holds the mic.

### 4. Agent commands

- **Model:** only on an agent tab whose turn is idle (the same gate that
  greys the Chat's model chip while the agent works). The name must be on
  the agent's model list (step 2), never free text. It is sent as
  `modelCommand(name)` through `sendSteeringPrompt`, as the chip's pick is,
  so the Reader shows it like any prompt. While the agent works it says
  "Claude is busy; try again when it's done" rather than queueing a switch
  behind the turn.
- **Effort:** Claude only, `/effort <level>` from `CLAUDE_EFFORTS`, the same
  path as the effort chip.
- **Plan/goal/clear:** `agentPlan`/`agentGoal` open the prompt box with the
  prefix as the keys do; dictation then fills it. `agentClear` asks first.
- **Question cards:** with a question card open in the active tab's Reader,
  an option answer picks it, through the card's own pick path.

### 5. Spoken feedback and the caption

- `describeLanding()` builds the one-line landing from the stores: scope
  name, tab label, and its state (`attentionByTab` decision/done,
  `busyByTab`): "Project Alpha, Claude, waiting for you." "Where am I" adds
  the subwindow and the tab's position; "what's waiting" counts the waiting
  tabs and names the first three (`statusTabs`).
- Spoken through the `TtsEngine` with priority: it cuts in front of a long
  read-aloud, which resumes from its next chunk.
- The header caption under the mic indicator shows the heard text and the
  outcome ("switch to project alfa → Alpha") for ~3 s, so a wrong match is
  visible even with the sound off. It uses the shared menu scheme and sets an
  explicit `color` if it is portaled.

### 6. Overlays

- "Open mail/calendar/to-do" runs `openApp` (it respects
  `steeringAppEnabled`). "Close" closes the open overlay.
- Commands that switch project or tab close an open overlay first, as a
  click on a pill does.
- Inside overlays, nothing more in this version: no "next mail", no "new
  to-do ‹text›" (Later).

### 7. Settings, i18n, docs

- Settings → Voice gains: voice commands on/off (experimental), the
  push-to-talk key (also in the shortcut table), the command word, and
  feedback: spoken line, or caption only.
- i18n: `voice.cmd.*`, `voice.nav.*` in English plus de/es/fr/it.
- `UntestedTag` + `src/lib/untested.ts` rows: `voice.nav.pushToTalk`,
  `.commandWord`, `.projects`, `.tabs`, `.newTab`, `.model`, `.confirm`,
  `.feedback`, `.overlays`.
- `docs/context/voice.md` (from the desktop plan) gains a navigation
  section: one command layer, arguments from live lists, push-to-talk only.
- File map rows: `src/lib/commands/appCommands.ts`,
  `src/lib/voice/voiceCommands.ts`.
- Help docs topic: "Voice commands", with the phrase list per language
  generated from the dictionaries, not copied.
- A `todo/` entry with 🖐️ boxes and per-platform ✅/❌ pairs.

## Verification

- **Unit tests:**
  - `appCommands`: each command's `available`/`run` against mocked stores;
    every `SteeringAction` covered or in `NOT_SPOKEN`. Steering's existing
    tests pass unchanged after step 1.
  - `voiceCommands.match` per language (step 2's list).
  - Model command: refused while busy, refused for a name not on the list,
    sends exactly `modelCommand(name)` when idle.
  - New agent tab: a disabled or uninstalled agent is not offered; root
    scope respects `rootAllowedAgentBins`.
  - Routing: push-to-talk never writes into a draft; the command word at the
    start of a dictated segment goes to the matcher and leaves the draft
    unchanged; without it, the segment is dictated.
  - Confirm: "confirm" closes, anything else or the 5 s timeout cancels.
- **Gates:** `scripts/gates.sh` for the touched set, then `--all` and
  `scripts/ci-local.sh` before any push.
- **Live, by the user** in the frozen dev build:
  1. Hold the key: "switch to project ‹name›": it switches and says where
     you landed. Try a name whisper might mishear; it asks back when two
     match.
  2. "New Claude tab", then "new shell", then "new Codex tab in project
     ‹other›".
  3. On an idle Claude tab: "change the model to Sonnet": the Chat shows
     `/model sonnet` and the model chip follows. While it works: refused.
  4. "Next waiting" through several waiting tabs; "what's waiting".
  5. "Close tab": the confirm box; say "confirm". Again, say "no".
  6. While a Chat dictates: "‹command word› open mail" opens mail, the draft
     unchanged; a sentence without the word is dictated.
  7. "Open calendar", "close", "to-do", "close".
  8. Sound off: the header caption alone tells you what happened.

## Organisation (if run as plan + implement + review)

- Step 0 in the main loop.
- Batch A: step 1 alone (a refactor of `useKeyboard.ts`; one implementer,
  reviewed before anything builds on it).
- Batch B, in parallel: step 2 (pure, frontend) ∥ the backend's `Command`
  mode and release-ends-segment (step 3's backend half, alone on cargo).
- Batch C: step 3's frontend half, step 4 and step 5. Batch D: steps 6–7.
- One reviewer per batch against the fixed decisions, and a final review
  across the whole diff.

## Later (each its own plan run)

- A wake word, as an opt-in for fully hands-free use (decision 1 left it
  out of this version).
- An opt-in model fallback for free-form requests the matcher misses ("the
  tab where Claude was fixing the PDF export"). A local model (Ollama) gets
  the utterance and the `AppCommand` schema, and its choice is said back and
  confirmed before it runs. It runs in-process, not as an MCP server any
  agent could call, and is off while the AI switch ⏻ is off.
- Inside overlays: "next mail", "reply", "new to-do ‹text›", "what's on
  today".
- Popout windows.
- The phone as the push-to-talk mic for the desktop, after the desktop
  plan's step 10.
- Spoken settings toggles (theme, AI switch ⏻) — each one would need its own
  safety review.

## Risks

- **The step 1 refactor** touches the keyboard path every steering user
  relies on. Mitigation: its own commit, steering's tests unchanged, and the
  user rechecks steering live before voice builds on it.
- **Name recognition.** Project names that are code words or acronyms are
  where whisper goes wrong. The prompt seeding, the fuzzy floor and the ask
  back are the defences; the live test decides whether a per-project "spoken
  name" alias is needed.
- **Command latency.** A command should feel instant. Releasing the key ends
  the segment without the silence wait; if `small` is still too slow, use
  `base` for commands (step 0).
- **Sticky model switches.** If a CLI makes a `/model` switch its default
  for new sessions (step 0's probe), the spoken confirmation says so, so a
  quick "try Haiku" does not quietly change every later session.
- **Two speakers.** Landing lines and read-aloud share one queue; a landing
  line interrupting an answer must resume it, never drop or repeat it.
