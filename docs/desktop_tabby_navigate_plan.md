# Desktop voice: "Tabby navigate" in the Chat mic

> **Status: built, not live-tested** (2026-11-22). Steps 1–8 are in the
> working tree; see "Built" at the end for what differs from the plan. The phone's half is built
> and not live-tested (`docs/done/voice_nav_mode_plan.md`, handoff
> `docs/done/voice_nav_mode_handoff.md`).

The phone's spoken navigation, brought to the desktop Chat's mic: say "Tabby
navigate" into an open mic, name a project, a box, a tab or "the done tab", hear
where you landed, and go on dictating there. It is the slim slice, inside the
mic a Chat tab already owns. The push-to-talk key, the window-owned mic and the
full command set of `docs/voice_navigation_plan.md` stay as planned there.

## Why

The desktop Chat has dictation, read-aloud and an experimental hands-free loop
(`docs/desktop_voice_plan.md`, steps 1–8). Moving to another tab or project
still takes the keyboard, and after a send the mic is closed (plain dictation)
or paused until the answer was read (hands-free), so nothing can be said while
the agent works. The phone closes both gaps with one mode and the Tabby gate.
The matcher and every phrase it needs are shared code already
(`src/lib/voice/voiceCommands.ts`, `voice.nav.*` in five languages).

## Fixed decisions (the user's, 2026-11-22)

1. **The Tabby gate, as on the phone.** With Hands-free on, the mic keeps
   listening after a send. Only an utterance that starts with "Tabby" counts:
   "Tabby navigate", "Tabby help", a spoken draft edit, or "Tabby ‹next
   prompt›" (the CLI queues it). Other talk is dropped. Plain dictation is
   unchanged: its mic ends at the send.
2. **Reach: projects and boxes, not root.** "Project ‹X›" and "box ‹X›" can
   be named, and the waiting / working / done queues walk projects and boxes.
   Root tabs are never a target, so a landing never opens a mic on the
   unfenced Host session. Tabby's own chats (`ASSISTANT_SCOPE`) are no target
   either.
3. **Main window only.** "Tabby navigate" said into a popout's Chat is not
   typed and shows "Navigation works in the main window". A jump whose target
   lives in a popout raises that window, says where it is, and ends the mode:
   no reading and no mic there.
4. **A plain mic follows the jump too.** With Hands-free off, the Chat landed
   on opens its mic for plain dictation: no gate, nothing read. (The phone
   opens a mic at a landing only with Hands-free on; it stays as it is.)

The phone plan's decisions 1, 3–7, 9 and 10 hold here unchanged (trigger
phrase, project asked back, queues across scopes, landing reads prompt then
answer, back to dictation after a landing, the gate and its cue, done means
unseen-done, a draft stays with its tab).

## Decided here (the user may override)

- **No backend change.** The session, its `handsFree` mode, `voice_speak` and
  the mute gate are enough; no new command, so no `command_class` row.
  `Owner` keeps only `Tab`.
- **One mode for both hosts.** The mode's logic (open / confirm / pick, the
  order of checks, the idle timer, the epochs) moves out of the phone's
  `useVoiceNav.ts` into a host-free controller, and both hosts drive it
  through ports. No second copy on the desktop. The phone's tests must pass
  unchanged; that step lands as its own commit before any desktop code.
- **Whisper finals are utterances.** The phone's utterance layer (`voiceInput.ts`
  `stepUtterances`) exists because Chrome re-finalizes a growing utterance.
  A desktop final is one segment the voice detector closed, so the desktop
  judges each final directly and needs no settle rule. Only the live preview
  needs holding back.
- **Order of checks for each final** (in `useReaderVoice`'s `onFinal`, before
  everything it does today): empty or filtered → as today; mode open → the
  mode; "Tabby help" → help; "Tabby navigate" → open the mode (words after it
  are its first command); gate on → keep a spoken draft edit whole, else
  "Tabby ‹rest›" passes `rest` on, else drop; then today's path (recovery,
  `pick`, the send guard, `onText`). So a navigation utterance wins over an
  open question's `pick` and never reaches the send guard; entering the mode
  resets a pending guard window.
- **The gate's rules are the phone's as built** (handoff, Flagged 1–2): the
  start word is exact (phonetic spelling plus `voice.assistantAliases`); a
  draft under way, or 10 s after "Tabby" alone, needs no start word. On: from
  a hands-free send until that turn is over and its answer read, and from a
  landing until the next send. Off: a click on the mic, text typed into the
  box, hands-free's reopen after a read, the session's end.
- **The mic is not paused for a turn any more** (hands-free). Today
  `waitingSince` pauses the session; with the gate it stays open and only a
  hidden pane pauses it. `waiting` keeps its other jobs: the line, the reopen
  effect, and telling read-aloud it may speak. While a gated draft is under
  way, read-aloud is held (`listening` true for it), so the voice never cuts
  an utterance by muting the mic.
- **Speaking needs no mic bounce.** Mode lines go through `voiceSpeak` under
  the tab's read id (`${ptyId}#nav:‹n›`); the backend throws captured audio
  away while it speaks plus a 300 ms tail. The mode's next step runs on that
  read's `speaking` event (`done` / `stopped` / `failed`), with a timeout so
  a voice that never reports its end cannot stall the mode. Lines are spoken
  with read-aloud on or off. No speech output (`voiceStatus` says so): lines
  are shown only.
- **Ten quiet seconds close the mode**, counted from the voice falling quiet;
  a partial arriving restarts them.
- **Lists come from the stores**, read when the mode opens: projects
  (`useProjectsStore`), boxes (`useBoxesStore`), the shown scope's tabs in
  strip order and its agents with `BUILTIN_AGENT_ALIASES`. Reserved scopes
  never enter a list.
- **The queues are steering's walk.** `statusTabs(kind, …)` from
  `lib/shortcuts/statusJump.ts`, without root, the assistant scope and tabs
  that have no Chat (the working walk also holds busy shells), then
  `nextStatusTab(list, shownStatusTab(), 1)`. Voice and the status keys
  agree on the order, "again" goes on from the tab shown, and a done tab
  leaves the list once it was shown. The phone's module cursor is not needed.
  A spoken jump writes the Back key's record (`afterStatusJump`) as a key
  jump does.
- **A project or box is asked back** ("Project Alpha?" / "Box Papers?"), then
  lands on its agent tab with the latest activity (`lastWorkingByTab` /
  `lastDoneByTab`), else its first agent tab. None: the scope is opened, "No
  agent tab in Alpha" is said, the mode and the mic end.
- **The jump is `jumpToTab(scope, key)`.** It returns where the tab lives; a
  popout label is decision 3's case.
- **The landing is a one-shot note in module state**, keyed by PTY id, stale
  after 30 s, taken by the Chat that becomes visible on that tab. The tab
  left drops its session at the jump (a hidden tab would only hold it
  paused). With Hands-free on the landing says "You asked: …", reads the
  answers after that prompt (at most three, else only the last, as
  read-aloud does) and starts the mic with the gate on, off if the box holds
  a draft. With Hands-free off nothing is read and the mic starts in plain
  dictation, ungated (decision 4). The note carries which of the two the
  jump was made in, so a Hands-free chip switched meanwhile does not change
  what the landing does.
- **A landing with no Chat** (the CLI's view is Terminal, the pane shows
  Diffs or Files, a shell): "‹agent› in ‹project›" is said before the jump
  and nothing listens there. Voice never switches a pane's view.
- **"Tabby help"** comes with it: `voice.help.dictation` while dictating,
  `voice.help.nav` in the mode, said and shown.
- **No new flag, no new setting.** The gate rides `voice_hands_free`
  (experimental). The mode in a plain mic gets `UntestedTag`s only.
- **Other matched commands** ("new shell", "open mail") answer "Not in
  navigation yet", as on the phone. They belong to
  `docs/voice_navigation_plan.md`.

## Steps

1. **The shared mode** — new `shared/voiceNavMode.ts`, pure with injected
   ports and clock. Out of `mobile-web/src/screens/terminal/useVoiceNav.ts`:
   the `Mode` union, `route` / `handle` (navigate said again, start word
   stripped, leave, help, confirm, pick, `match`), `enter` / `exit` / `leave`,
   the idle timer, epoch and turn counters, the command chain. Ports:
   `lang`, `tr`, `say(text, next)`, `showLine`, `chime`, `loadLists`,
   `resolve(command)` (the host turns a command into "say and listen",
   "ask back", "jump" or "say and end"), `onOpen(open)`, `leaveToDictation`.
   `useVoiceNav.ts` becomes the phone's adapter. Also out of
   `mobile-web/src/voiceNav.ts` into `shared/voiceNav.ts`: `promptForVoice`
   and the turns half of `landingRead` (`landingFromTurns(turns)`), which the
   phone's `landingRead` then calls. Proof: `MobileVoiceNavMode.test.tsx`,
   `MobileVoiceNav.test.ts` and `MobileTerminalVoice.test.tsx` pass
   unchanged; new `src/__tests__/terminal/VoiceNavMode.test.ts` drives the
   controller with fake ports. Own commit.
2. **Words** — `src/lib/i18n/*` ×5. `mobile.voice.navOpen`,
   `mobile.voice.tabbyCue` and `mobile.voice.tabbyListening` move to
   `voice.nav.open`, `voice.gate.cue`, `voice.gate.listening`, read by both
   hosts. New: `voice.nav.box` ("Box {name}?"), `voice.nav.mainOnly`. An
   `openBox` phrase check per language in `VoiceCommands.test.ts` ("box
   Papers" resolves to `openBox`, not `goToTab`).
3. **Desktop targets** — new `src/lib/voice/desktopNav.ts`, pure over store
   snapshots: `navLists(projects, boxes, tabs, agents)`, `navQueue(kind, …)`
   (decision 2's filter over `statusTabs`), `scopeAgentTab(scope, tabs,
   lastWorking, lastDone)`, `tabAtNumber`, `agentTabChoice`, and the landing
   note (`leaveLanding` / `takeLanding`, 30 s). Tests in new
   `src/__tests__/terminal/DesktopVoiceNav.test.ts`: root and assistant tabs
   never listed, a busy shell not in the working queue, "again" walks on, a
   stale or foreign note dropped.
4. **Hold-back** — `src/components/terminal/useLiveDictation.ts` `show`:
   `mayNavigate` and `mayAskHelp` beside `mayEditDraft`, so a "Tabby
   navigate" in the making shows on the "Heard:" line and never in the draft.
   `ReaderVoice.tsx` `onPartial`: every partial is held while the mode is
   open, and while the gate is on unless it starts with the start word or a
   draft is under way. Tests in `ReaderVoice.test.tsx`.
5. **The mode in the Chat mic** — new
   `src/components/terminal/useReaderVoiceNav.ts`, the desktop adapter of
   step 1: `say` over `voiceSpeak` and the `speaking` event, `loadLists` and
   `resolve` over step 3 and the stores, the jump (`jumpToTab`, the Back
   record, the note, the left tab's `drop()`), decision 3's popout branches
   (`isDetachedWindow()`; a popout label from `jumpToTab`). `ReaderVoice.tsx`:
   the order of checks above in `onFinal`, the mode's line on the voice strip
   (a click skips the voice), the reopen-after-turn effect deferring while
   the mode is open, `UntestedTag`s. Tests in new
   `src/__tests__/terminal/ReaderVoiceNav.test.tsx` on `ReaderVoice.test.tsx`'s
   fake session.
6. **The gate** — new `src/components/terminal/useReaderTabbyGate.ts` (the
   phone's `useTabbyGate.ts` state, with `GATE_WINDOW_MS` moved to
   `shared/voice.ts` so both import one value; if the two hooks end up the
   same, one hook in `src/lib/voice/` serves both). `ReaderVoice.tsx`:
   `awaitTurn` arms it (chime, cue line) instead of pausing; the pause effect
   drops `waitingSince`; `onFinal` routes through it while waiting; the gate
   clears at the reopen, a mic click, typed text (`TerminalReaderView`
   tells it) and the session's end. `TerminalReaderView.tsx`: read-aloud's
   `listening` is true while a gated draft is under way. Tests: talk without
   the start word dropped during a turn, "Tabby and add a test, go Tabby"
   queues a second send, "Tabby scratch that" still edits, the answer is read
   after a gated draft was sent, a click on the mic clears the gate.
7. **The landing** — new `src/components/terminal/useReaderVoiceLanding.ts`,
   mounted by `ReaderComposer`: takes the note when the pane is visible.
   A Hands-free note waits for the first transcript read (at most 6 s), says
   the lines of `landingFromTurns(sessionTurns)` through `voiceSpeak`, marks
   those answers known to `useReaderReadAloud` (a new `markRead(keys)` on its
   return, so the turn's end does not read them twice), then starts the mic
   with the gate. A plain-mic note starts the mic at once, in plain
   dictation, ungated, and says nothing. Either start is `useReaderVoice`'s
   own `start()`, so a box still `disabled` (the CLI not up yet) or a missing
   speech model behaves as a click on the mic does. Tests in
   `ReaderVoiceNav.test.tsx`: prompt then answer read, then the mic opens
   gated; a draft in the box opens it ungated; a stale note does nothing; a
   plain-mic note reads nothing and opens the mic ungated in `dictate` mode.
8. **Docs and registers** — `docs/context/voice.md` (a "Spoken navigation on
   the desktop" section: finals are utterances, the mic stays open through a
   turn, queues are steering's walk, root is out of reach, main window
   only); `docs/help/talking-to-an-agent.md` (desktop paragraph);
   file-map rows for the five new files and the changed `useVoiceNav.ts`
   row; status lines of `docs/voice_navigation_plan.md` and
   `docs/desktop_voice_plan.md` (step 9: slim slice built, push-to-talk
   open); `src/lib/untested.ts` rows `terminal.reader.voice.navigate`,
   `.tabbyGate`, `.help`; a `todo/group-s-agents.md` entry with 🖐️ boxes
   and the four platform pairs.

## Verification

- Unit: the tests named in steps 1–7.
- Gates: `scripts/gates.sh` (frontend set: build, test, lint, brand-check).
  No Rust file changes, so `backend:stale` has nothing to report.
- Live, by the user, in the dev build after the commits (never run by an
  agent). Hands-free and read-aloud on, in the main window:
  1. In a Claude Chat, click the mic, dictate a prompt ending "go Tabby": a
     chime and "Sent — say Tabby for your next prompt". Talk without "Tabby":
     nothing lands. "Tabby, and add a test, go Tabby" queues the second
     prompt.
  2. "Tabby navigate", "project ‹name›" → "Project ‹name›?" → "yes": that
     project comes up on its agent tab, your last prompt and the answer are
     read, then the mic listens there.
  3. "Tabby navigate, the done tab" twice: two different done tabs, in the
     order the next-done key walks them. Press the Back key: the tab you
     left.
  4. "Tabby navigate", "box ‹name›" → asked back → lands in the box.
  5. With a root agent waiting: "Tabby navigate, the waiting tab" never lands
     on it.
  6. "Tabby navigate", then silence: "Navigation closed" after about 10 s.
  7. "Tabby help" while dictating, and "help" inside the mode.
  8. In a popout's Chat: "Tabby navigate" shows "Navigation works in the main
     window" and types nothing. From the main window, jump to a tab that
     lives in a popout: the window is raised, the line is said, no mic.
  9. Hands-free off, plain mic: "Tabby navigate, tab two" jumps; nothing is
     read, the mic is on in tab two, and what you say next is dictated
     there without "Tabby" in front. After a send the mic is off, as today.

## Organisation

Three commit units in sequence, frontend only: step 1 (the phone refactor,
reviewed against the phone's unchanged tests before anything builds on it);
steps 2–5 (navigation in an open mic, usable without the gate); steps 6–8
(the gate, the landing, docs). Hot files for whoever is running: the five
dictionaries, `src/lib/untested.ts`, the file maps, `ReaderVoice.tsx`.

## Later

- Landings across windows (a popout's Chat taking the mic through an app
  event).
- Whisper's initial prompt seeded with the live project, box and tab names.
- The rest of `docs/voice_navigation_plan.md`: push-to-talk, `Owner::Window`,
  new tabs, model and effort, the apps.

## Risks

- **Step 1 touches phone code that was never run live.** Its tests are the
  only proof on both sides; the phone's live check (handoff steps) should
  run before or together with the desktop's.
- **An open mic through every turn.** With Hands-free on, room talk is
  transcribed for as long as the agent works. It is dropped unless it starts
  with "Tabby", stays on the machine, and the header mic shows it; but
  whisper now runs during turns, and a false "Tabby …" queues a prompt. The
  send guard still stands in front of every hands-free send.
- **Names.** Whisper mishears code words and acronyms; the ask-back, the
  alias lists and the fuzzy floor are the defences until the prompt seeding
  exists.
- **Read-aloud and the gate share one voice and one mic gate.** The
  hold-while-drafting rule (step 6) is what keeps an answer from muting a
  prompt in the making; it needs the live check most.

## Built (2026-11-22, uncommitted, not live-tested)

All eight steps are in the working tree, on top of another session's
uncommitted phone work ("Tabby help", phone navigation in a plain mic), which
step 1 had to fold in; nothing is committed. Differences from the plan:

- **Hosts answer through `ctx.apply`**, not by returning an outcome. An
  awaited return added microtask ticks and moved one phone line a tick
  later (`MobileVoiceNavMode` "no agent tab" failed); calling `apply` where
  the old code spoke keeps the phone's timing exact.
- **The desktop gate is its own hook** (`useReaderTabbyGate`): it adds
  `drafting`, which read-aloud's hold needs and the phone's `useTabbyGate`
  does not have.
- **A leading start word is stripped behind the gate even when its window
  is open or a draft is under way** (the phone keeps it in the text then), so
  "Tabby, and add a test" never types "Tabby".
- **Leaving the mode does not touch the gate** on the desktop (the phone sets
  it to Hands-free's state): the gate means "a turn is running or a landing
  is waiting for the next send", which the mode does not change.
- **Whether a tab shows its Chat** is read from its pane's view registration
  when the pane is on screen, else from its CLI's Chat/Terminal choice. A
  hidden pane left on Diffs or Files reads as Chat: the jump then lands
  silently (the note goes stale).
- **A box not opened this session**: "yes" opens it, then lands on its agent
  tab (with the note); a box with no agent tab ends there without "No agent
  tab in …". A project is restored (`restoreProjectScope`) before its tab is
  picked.
- **The landing note carries `where`**, said when the conversation holds no
  prompt yet.
- **The hold-back tests** are in `ReaderVoiceNav.test.tsx` beside the rest of
  the desktop mode's, not in `ReaderVoice.test.tsx`. Two `ReaderHandsFree`
  tests that checked the old pause-for-the-turn now check the gate.

### Review (2026-11-22)

Phone equivalence: no user-visible difference (two internal reorders, both
inert). Desktop: fixed, with regression tests in `ReaderVoiceNav.test.tsx`
where marked —
- a landing on a tab shown before read the transcript the hidden pane still
  held; it now waits for a read made since the pane was shown (tested);
- the tab a jump left kept waiting for its turn, so coming back to it reopened
  an ungated mic by itself; the jump clears that wait (tested);
- a box not open yet wrote the Back record from the box's tab (tested); it
  now says "No agent tab in …" when it holds none;
- a jump to a Chat already on screen (another subwindow) never took its note
  (tested); a landing on a box not ready yet (CLI starting) waits up to 30 s
  for it;
- a gated draft scratched to nothing kept read-aloud held;
- a line queued behind a long read could be given up before it was said
  (the guard now starts at the read's `started`);
- a click on the mic during a mode line now stops the voice too.

Then fixed too: the reopen after a turn no longer clears the gate under an
utterance being said — that segment is judged gated, then the gate goes off
(tested); `matchNavigate` / `mayNavigate` hear the English phrase in every
language, as `matchHelp` does (phone too; tested).

Open: a click that skips a mode line stops every queued read of the machine,
read-aloud's included — `voice_speak_stop` takes no read id, and a per-id
stop is a backend change this plan ruled out.
