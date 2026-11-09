# Phone voice: "Tabby navigate" and "Tabby" prompts in the Focus mic

Status: plan (2026-11-09). Nothing built. A slim slice of
`docs/phone_voice_plan.md` that needs none of its probe results: it lives
inside the Focus screen's existing mic (`screens/terminal/useVoiceInput.ts`,
`useHandsFree.ts`), not in that plan's App-level session (S3/S4), which stays
as planned for later. It reuses what that plan already landed: the matcher
(`src/lib/voice/voiceCommands.ts`, S1), the reading model
(`shared/voiceReading.ts`, S2) and the read-aloud cursor
(`mobile-web/src/speechOutput.ts`, S6).

Base: the "go on keeps listening" change (a spoken "go on" sends and leaves the
mic open; hands-free holds the turn's answers until nothing is dictated, then
closes the mic to read them). Handoff: none yet (`docs/phone_voice_handoff.md` is the sibling plan's).

## Why

With the mic left open after "go on", the phone can stay in a voice loop:
send a prompt, move to another tab or project, hear where you landed, say
the next prompt — without touching the screen. Two gaps remain: everything
said near the open mic lands in the draft, and moving between tabs and
projects still needs a finger.

## Fixed decisions (the user's, 2026-11-09)

1. **Trigger: "Tabby navigate".** The assistant's name
   (`BRAND.assistant`, never a literal) plus the navigate word opens
   navigation mode. This drops `phone_voice_plan.md`'s "the command word must
   not be Tabby" rule for this phrase. The plan's `voice.commandWord`
   (`{app}`) is untouched.
2. **Slim, inside Focus.** Navigation mode works from the Focus screen's mic
   while Hands-free is on (decision 8). No App-level session, no Media
   Session, no idle-lock change.
3. **"Go to project ‹Y›" asks back.** The project name the matcher
   understood is said back ("Project Alpha?"), and the user answers yes or
   no (`matchConfirm`). No → navigation mode stays open for another try.
4. **"Go to the working tab" / "the done tab"** (and "waiting") jump to the
   next such tab in the phone's activity order **across all projects**;
   saying it again goes on to the one after.
5. **Landing: the last prompt, then the answer.** On the tab it jumped to,
   the user's last prompt there is read ("You asked: …"), then the agent's
   answer to it.
6. **After a landing, back to dictation.** Navigation mode ends and the mic
   dictates for the tab landed on. "Tabby navigate" again moves on.
7. **"Tabby" starts a prompt; a cue says "go on".** While the mic stays open
   after a send (and after a landing), what is heard is dictated only from an
   utterance that **starts with "Tabby"**: the words after "Tabby" start the
   draft, earlier talk is dropped. After every send a cue (a chime and the
   line "Sent — say Tabby for your next prompt") tells the user they can go
   on with the next prompt.
8. **Hands-free only.** "Tabby navigate" and the Tabby gate work only while
   Hands-free is on (answers are held and read between prompts there).
   With Hands-free off, the mic and "go on" behave as today: no gate, no
   navigation mode, no send cue.
9. **"The done tab" means unseen-done only**, as Home's Needs you counts it;
   a landing marks it seen, so saying it again moves on.
10. **A half-dictated draft stays with its tab** across a jump (`drafts.ts`).

## Decided here (the user may override)

- **Utterances, not deltas (the load-bearing part).** The dictation hook gets
  `step.insert`, the *words finalized since the last event*, not utterances:
  Android's Chrome finalizes one utterance several times as it grows ("Tabby",
  then "Tabby navigate", then "Tabby navigate go to project Alpha"), and
  `readDictation` hides where the utterance began. So "starts with Tabby" and
  "Tabby navigate" cannot be read off an insert. A pure layer in
  `voiceInput.ts` reads the **current utterance** (the words from the last
  utterance start in the result list, plus the live interim) and a **settle**
  rule decides when it is whole (no new result for ~800 ms, or a new utterance
  starting). Rules that follow:
  - a command (`Tabby navigate …`, a nav answer) is matched only on a settled
    utterance, never on a growing one;
  - **hold-back:** while the utterance so far is only the start word (or
    "Tabby" + a prefix of "navigate"), nothing of it is inserted into the draft
    — gate on or off — until the next word or the settle shows it is
    dictation; with the gate off the held words are then inserted unchanged;
  - the gate's keep/drop verdict is made once per utterance (by its first
    word) and kept for the rest of that utterance, so later growth of the same
    utterance is judged as the first part was; a recognizer restart
    (`onRestart`) ends the utterance.
- **When the Tabby gate is on:** from a spoken send ("go on") or a landing
  until the next send. Off, and only then: a tap on the mic, text typed into
  the box (also a draft already present at a landing), hands-free's own
  pause-send and its reopen after a read. A programmatic mic start (navigation,
  landing) sets the gate; only the *tap* handler clears it — the two are told
  apart by a parameter of the start, not by guessing. "Tabby" alone plays the
  chime and shows "Listening for your prompt"; the next utterance then starts
  the draft (a gate-open window of ~10 s, then closed again).
- **Order of checks for each settled utterance:** navigation mode, if open
  (below) → "Tabby navigate" → the spoken draft edits (built 2026-11-09
  before this plan: `matchDraftEdit` in `useVoiceInput`'s `onResult`, ahead
  of the hands-free block — "Tabby scratch that / replace X by Y /
  correction … / clear all / plan / goal", each a whole utterance;
  `docs/context/voice.md`) → the Tabby gate → hands-free's guard and
  `pick` → dictation (and "go on" at its end, unchanged). So the first two run
  *before* the hands-free block in `useVoiceInput.ts`'s `onResult` (a nav
  utterance never reaches `guard.settled` or `pick`; it resets a pending
  guard window). The send guard's "stop" is untouched outside navigation mode;
  inside it "stop" leaves the mode. "Tabby navigate …" said mid-draft is a
  navigation command too; the draft stays untouched (and is kept per tab by
  `drafts.ts` across the jump).
- **The cue is a chime and a shown line, not spoken.** Nothing is spoken while
  the mic is open (`useSessionChat` stops the voice whenever `listening`), and
  a spoken "say Tabby …" would be heard by the open mic as a start word.
  `playChime()` plus the voice line.
- **Inside navigation mode**, each settled utterance goes to
  `match(text, lang, lists, { requireCommandWord: false })`. "Tabby navigate
  go to project Alpha" in one breath works. The lists are built on the phone
  from rows it already holds, opaque ids only (`mobile_control` unchanged, no
  new route): `projects` from `GET /api/v1/projects` (`ProjectRow.label`, kind
  project only, fetched when the mode opens), `tabs`/`agents` of the current
  project from `GET /api/v1/projects/{id}` (`ProjectDetail.tabs`, `.agents`;
  `BUILTIN_AGENT_ALIASES` for the agent names). Commands handled:
  - `openProject` → ask back (decision 3: `matchConfirm`), then land on that
    project's most recently active agent tab: the agent tab (available, not
    `sign_in`/`cloud`) with the highest `TabRow.last_activity` in
    `ProjectDetail.tabs`, else its first agent tab. (The activity list holds
    only working/waiting/done tabs, so it cannot answer this.) A project with
    no agent tab opens the Project screen, says "No agent tab in Alpha", and
    the mic ends (that screen has no mic).
  - `nextWaiting` / `nextWorking` / `nextDone` → decision 4, from
    `getActivity()` (`desktop_available: false` → "The desktop is not
    available", mode stays open). The order is the phone's own, shared with
    Home's Needs you and the Agents view: **waiting** = Needs you's `asking`
    group (questions first, then cut-off turns, newest first); **done** =
    Needs you's `finished` group (done and not yet opened on this phone, newest
    first — `seenDone.ts`), and the landing marks the tab seen
    (`markDoneSeen`) as Project/Home do, so "the done tab" again reaches the
    next one by itself; **working** = status `working`, in `sortAgentTabs`
    `lastWorking` order. For waiting and working, "again" is a module cursor
    (the last tab jumped to; the next candidate after it in order, wrapping,
    never the tab the user is on). None: "Nothing is working" / "Nothing new is
    done" / "Nothing is waiting", mode stays open. The two Needs-you filters
    are lifted out of `NeedsYou.tsx` into one exported pure function that both
    it and the voice code call; no second copy.
  - `goToTab` / `agentTab` / `tabNumber` → in the current project, over the
    lists above: `tabNumber` is the position in `ProjectDetail.tabs`;
    `agentTab` with `n` is the n-th tab of that agent in that order, without
    `n` the one with the highest `last_activity`.
  - an ambiguity → `ambiguityLine`, then `resolveAmbiguity` on the next
    utterance.
  - a leave phrase ("stop", "cancel", "never mind"; a new `voice.nav.leave`
    key, the matcher's `stop` template is not enough for the last two) →
    leave navigation mode, back to dictation (the gate on).
  - any other matched command → "Not in navigation yet"; unmatched →
    `didNotCatchLine`. The mode stays open for both.
  - **The words "go to the working/done/waiting tab" are not templates today**
    (`voice.cmd.nextWorking` etc. are "next working|next working tab|next
    running"; "go to the done tab" would be a `goToTab` with an unknown name).
    Step 1 adds them as alternatives to those three keys in all five
    dictionaries ("go to the done tab", "the done tab", and the other languages'
    equivalents), with tests that they win over `goToTab` and `doneTodo`.
  - 10 s with no utterance → mode ends with a short "Navigation closed". The
    10 s run from the moment the mic is open and quiet after the last line
    (not while the phone speaks or the mic is being restarted).
- **Spoken lines in navigation mode** are always spoken, read-aloud on or
  off: the mode is voice-driven (`speak()` is not gated on the read-aloud
  flag). Half-duplex as hands-free does it: the mic closes while the phone
  speaks and opens again ~300 ms after the voice falls quiet (the desktop plan's
  tail; `endDictation()` then `startVoice()` — `endDictation` clears
  `recognition.current` at once, so the pair is safe back to back). On a
  browser with no speech output (`speechOutputSupported()` false) the lines are
  shown on the voice line only and the mic stays open; the mode still works.
  `unlockSpeech()` is called in the mic button's tap handler (today only the
  menu rows call it); it is page-wide, so it survives the Terminal remount.
  **Hands-free interplay:** while the mode is open, hands-free's reopen
  (`startVoiceRef` in `useHandsFree`) and its wait effect defer to the mode
  (one ref the mode sets; the mode owns the mic until it ends), and entering
  the mode drops a pending guard window. A hands-free wait for a turn of the
  tab being left is simply not carried over the jump.
- **Crossing tabs:** `App.tsx` keys `Terminal` by tab id, so a jump unmounts
  the screen and its recognizer (`useVoiceInput`'s cleanup aborts it). The
  jump leaves a one-shot "landing" in module state (`mobile-web/src/voiceNav.ts`:
  tab id, the Tabby gate on, what to read, time), and the new Terminal takes it
  on mount. A landing older than ~30 s, or for another tab, is dropped. The jump
  itself is `openTab(next, { project })`: the existing `openTab` prop gets an
  optional `project` in its `opts` and `App.tsx`'s closure uses it instead of
  `terminal.project` (no second prop; Home's `openTab(projectId, row)` already
  shows the pattern). Starting the mic on the new screen waits for `connected`
  (`startVoice` returns silently while the socket is down) and for the landing
  read to finish; it is not from a tap, as hands-free's reopen is not, so a
  browser that refuses it shows the existing failure line and the mic button
  works as usual. Only agent tabs have a mic: a landing on a shell tab reads
  nothing, starts no mic, and ends the mode.
- **Reading the landing:** the last `prompt` turn of the tab's transcript
  (`transcriptTurns`, from the Terminal's own `getTranscript` read — the landing
  waits for it, at most ~6 s) as "You asked: ‹text›" (long prompts cut to
  their first ~2 sentences); a tab whose transcript cannot be read falls back
  to `lastPrompt(tab)` (`agentPrompts.ts`) and says there is no answer to
  read. Then the answers after that prompt, read through the S6 cursor. The
  cursor's reading exists only after the Terminal's first `feedReading`
  (`useSessionChat`), so the landing starts after that feed, and uses
  `readTurn(tab, sinceKey)` with `sinceKey` = the key of the newest answer
  *before* that prompt (null if none): it reads the last
  `MAX_SPOKEN_AT_ONCE` of them and follows later ones, as any reading does, so
  "repeat", "next", "back" work as on any reading. A prompt with no answer yet
  (the tab is working) says "No answer yet"; a tab whose Focus is not the
  stored session (Terminal view, no session) says only where it landed
  ("Claude in Alpha"). While the landing is read the mic is closed; a tap on
  the voice line stops the voice and opens the mic. A tab with no prompt yet
  says only where it landed.
- **Words per language** go in `voice.*` keys in all five dictionaries (en, de,
  es, fr, it), using the dictionaries' existing `{assistant}` placeholder
  (`fillBrand` fills it from `BRAND.assistant`; no literal name anywhere,
  tests included — they read `BRAND.assistant`): the navigate phrases
  ("{assistant} navigate|{assistant} navigation"; de "{assistant} navigiere|
  {assistant} Navigation"), the start word ("{assistant}"), the leave phrases,
  and the lines (the cue, "Listening for your prompt", "Project {name}?",
  "No agent tab in {name}", "Nothing is working" and its siblings, "Not in
  navigation yet", "Navigation closed", "You asked: {text}", "No answer yet").
  Recognizers write "Tabby" as "tabby", "Tabbi", "tabi" or "Tavi": the start
  word check takes the matcher's fold + `phonetic` + `similarity` against the
  *first word only*, at a stricter bar than `NAME_FLOOR` (one edit on a
  four-letter word is 0.75, which also lets "taxi", "Toby" and "tabs" through),
  plus an alias list in a dictionary key (`voice.assistantAliases`) so the
  spellings are data. Tests cover the rejected near-words in every language.
- **Untested pills:** `mobile.voice.navigate` (navigation mode) and
  `mobile.voice.tabbyStart` (the gate and the send cue), rows in
  `src/lib/untested.ts`, shown on the voice line as the existing
  `mobile.voice.spokenSend` pill is (the row needs a call site:
  `UntestedRegistry.test.ts` fails on a row no site uses).
- No backend change: `getActivity`, `getTranscript`, `GET /api/v1/projects`
  and `GET /api/v1/projects/{id}` are enough. No new route, so no
  `command_class` row.

## Steps

1. **Matcher and words** (`src/lib/voice/voiceCommands.ts`, pure; i18n ×5):
   `matchNavigate(utterance, lang) → { rest: string } | null`,
   `matchStartWord(utterance, lang) → { rest: string } | null` (rest may be
   empty; **built** with the draft edits: `voice.startWord`, one letter off in
   four, first letter fixed, one word or two run together) and `matchNavLeave(utterance, lang)`, on the first words only; the
   "go to the working/done/waiting tab" alternatives and every key named above.
   Tests per language in `src/__tests__/terminal/VoiceCommands.test.ts`:
   "tabby" inside a sentence (not a start), "Tabby navigate" with and without
   a command after it, "Tabby" alone, the mis-spellings, the rejected
   near-words, "go to the done tab" resolving to `nextDone`.
2. **Utterance layer** (`mobile-web/src/voiceInput.ts`, pure):
   `readDictation` also returns where the current utterance starts;
   `utteranceOf(...)`, the settle rule, the hold-back rule and the per-utterance
   gate verdict as pure functions over `DictationProgress`. Tests in
   `src/__tests__/mobile/MobileVoiceInput.test.ts` with real recognizer event
   sequences: Android re-finalizing a growing utterance, a restart, two
   utterances back to back, "Tabby" and "navigate" arriving in separate events.
3. **Tabby gate and send cue** (`useVoiceInput.ts`, `useComposer.ts`,
   `Terminal.tsx`'s voice line and mic tap handler): the gate state (a ref plus
   state for the line), dropping pre-"Tabby" talk, the chime + shown line after
   every spoken send, the tap/typing reset, `unlockSpeech()` in the mic tap.
   Tests in `src/__tests__/mobile/MobileTerminalVoice.test.tsx`.
4. **Targets and landing store** (new `mobile-web/src/voiceNav.ts`, pure +
   module state): the lists from `ProjectRow`/`ProjectDetail`, the project →
   tab choice, the three queues (the Needs-you filters lifted out of
   `NeedsYou.tsx` and shared) with the cursor, the one-shot landing (take once,
   stale after ~30 s, other tab dropped). Tests in a new
   `src/__tests__/mobile/MobileVoiceNav.test.ts`.
5. **Navigation mode** (new `screens/terminal/useVoiceNav.ts`;
   `useVoiceInput.ts` routes settled utterances to it before the hands-free
   block; `useHandsFree.ts` defers its reopen; `Terminal.tsx` and `App.tsx`
   for `openTab`'s `project` option): the state machine above, the ask back,
   the jumps, half-duplex speech, the 10 s timer. Tests in a new
   `src/__tests__/mobile/MobileVoiceNavMode.test.tsx` (fake recognizer and
   `speechSynthesis` as in `MobileTerminalReadAloud.test.tsx`).
6. **Landing read and mic restart** (the new Terminal's mount, through
   `voiceNav.ts` and `speechOutput.ts`): waits for `connected` and the first
   transcript feed, last prompt, answer through the cursor, then dictation with
   the gate on. Tests in the same new file.
7. **Docs and registers:** `docs/help/talking-to-an-agent.md` ("On the
   phone"), `docs/context/voice.md` (a short navigation-mode paragraph),
   file-map rows for the new files (`voiceNav.ts`, `useVoiceNav.ts`), the
   untested rows, and a pointer from `docs/phone_voice_plan.md`'s status to
   this plan (decision 1 there is overridden for "Tabby navigate").

## Verification

- Unit: steps 1–2's tests; the gate (talk before "Tabby" dropped, the rest
  drafted, a growing utterance judged once, the cue after a send, a tap resets
  it, a programmatic start does not); navigation (ask back yes/no, next
  working across projects and the one after, next done marks seen and reaches
  the next, a project with no agent tab, unmatched keeps the mode, the 10 s
  timer pauses while the phone speaks, "stop" leaves it, hands-free's reopen
  deferred while it is open); the landing (prompt then answer read after the
  first feed, then the mic opens with the gate on; a stale landing dropped; a
  shell tab ends the mode).
- Gates: `scripts/gates.sh` (frontend only: build, test, lint,
  brand-check).
- Live, by the user (the frozen dev build after the commit; never run by an
  agent):
  1. Focus on a Claude tab, tap the mic, say a prompt ending "go on": the
     chime and "Sent — say Tabby …"; talk without "Tabby" — nothing lands;
     "Tabby, and add a test, go on" sends "and add a test".
  2. "Tabby navigate", "go to project ‹name›" → "Project ‹name›?" → "yes":
     it opens that project's agent tab, reads your last prompt and the
     answer, then listens; say "Tabby …" for the next prompt.
  3. "Tabby navigate go to the done tab" twice: two different done tabs.
  4. "Tabby navigate", then silence: "Navigation closed" after ~10 s.
  5. With hands-free on: send with "go on", then "Tabby navigate" during the
     wait for the answer: the mode opens, the answer's reading does not talk
     over it.

## Organisation

- **Shape:** one coupled chain on the phone (steps 2–6 share
  `useVoiceInput.ts`/`Terminal.tsx`), too long for one implementer: **two
  implementers in sequence in one worktree** — N1 steps 1–3 (matcher, utterance
  layer, gate), N2 steps 4–7 (navigation, landing, docs) starting from N1's
  commits; plan steps are commit units. Then one reviewer (bugs only, each
  fixed with a regression test, design doubts to "Flagged for user"); the main
  loop merges.
- A plan reviewer reads this plan against the code first and amends it (done,
  2026-11-09, below).
- Hot files (`src/lib/i18n/*`, `src/lib/untested.ts`, the file maps) belong to
  the one implementer running; no parallel implementer touches them.

### Agent steps

| Agent step | Plan steps | Files |
|---|---|---|
| N1 implement | 1–3 | `src/lib/voice/voiceCommands.ts`, `mobile-web/src/voiceInput.ts`, `screens/terminal/useVoiceInput.ts`, `useComposer.ts`, `Terminal.tsx` (voice line, mic tap), i18n ×5, `untested.ts` (tabbyStart), tests |
| N2 implement | 4–7 | `mobile-web/src/voiceNav.ts` (new), `screens/terminal/useVoiceNav.ts` (new), `useVoiceInput.ts`, `useHandsFree.ts`, `Terminal.tsx`, `App.tsx`, `components/NeedsYou.tsx` (shared filters), i18n ×5, `untested.ts` (navigate), tests, docs |
| N3 review | all | bugs only |

## Plan review (2026-11-09)

Read against the code. Fixed decisions untouched. Changed:

- **Utterances vs deltas:** "starts with Tabby" and "Tabby navigate" cannot be
  read off `step.insert` (words finalized since the last event; Android
  re-finalizes a growing utterance, `readDictation` does not expose the
  utterance start). Added the utterance layer, settle rule, hold-back and
  per-utterance gate verdict; new step 2.
- **"Go to the done/working tab" is not a template** (only "next done tab"
  etc.; "the" is not stripped): added the alternatives to step 1. Added the
  leave phrases ("cancel", "never mind" are not `stop` templates).
- **Activity order:** Needs you lists only asking and unseen-done tabs, not
  working ones; decision 4's order is now spelled out per kind (Needs-you
  filters shared, `sortAgentTabs` for working, `markDoneSeen` on landing, a
  cursor for "again"). **A project's most recent agent tab** comes from
  `ProjectDetail.tabs[].last_activity`, not the activity list.
- **Lists for the matcher** (projects, current project's tabs and agents) and
  their source routes stated; opaque ids only, no new route.
- **Echo:** the cue is not spoken (the open mic would hear "say Tabby");
  `useSessionChat` already silences speech while `listening`; 300 ms tail
  added; no-TTS fallback; 10 s timer paused while speaking.
- **Landing read:** `readTurn` needs the reading that the Terminal's first
  `feedReading` creates, and a `sinceKey`; the landing waits for the transcript
  and `connected` (`startVoice` returns silently without it); fallbacks for no
  session, no answer yet, shell tabs.
- **Speech unlock:** only the menu rows call `unlockSpeech` today; added it to
  the mic tap. **Hands-free:** nav utterances run before the guard/`pick`; its
  reopen defers to the mode.
- `openTab` gets an optional `project` instead of a second prop.
- `{assistant}` placeholder exists (`fillBrand`); aliases as a dictionary key;
  near-word false positives ("taxi", "tabs") tested.
- The handoff file named at the top does not exist yet (only
  `docs/phone_voice_handoff.md`); the main loop writes it after the run.
- Steps 2–6 were too big for one implementer: split into N1 and N2.

### Questions for the user — answered 2026-11-09

All three answers are fixed decisions 8–10 above.
