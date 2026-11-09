# Voice nav mode — implementer handoff

Plan: `docs/voice_nav_mode_plan.md`. Each agent step appends its section: commits, what landed, interfaces, gate status with test counts, "Flagged for user".

## N1 (plan steps 1–3) — done

Worktree `voice-nav`, base be8e75ab. Commits:

| sha | step |
|---|---|
| `93ef6ec6` | 1 — matcher and words |
| `39632a11` | 2 — utterance layer (`voiceInput.ts`, `startLexicon.ts`) |
| `5ecc8c88` | 3 — Tabby gate and send cue (`useTabbyGate.ts`, `useVoiceInput.ts`, `useHandsFree.ts`, `Terminal.tsx`) |

### Read first: the draft-edit work is NOT in this branch

The plan says `matchStartWord`, `voice.startWord` and `matchDraftEdit` were "built
2026-11-09 before this plan". They are only uncommitted edits in the main checkout
(`voiceCommands.ts`, `draftEdit.ts`, `useVoiceInput.ts`, the i18n files, `untested.ts`);
the worktree base be8e75ab has none of them. So:

- Step 1 **re-implemented** `matchStartWord` and `voice.startWord` here, with the same name,
  signature (`{ rest } | null`) and dictionary key, and the same `tokenize` refactor of
  `words()`, so those hunks should merge clean or conflict trivially. The start-word *bar*
  differs, deliberately (see Flagged): exact phonetic spelling plus `voice.assistantAliases`,
  not main's "one letter off in four" (0.75), which lets "taxi", "Toby", "tabs" through.
  Main's `matchDraftEdit` uses its own `startWordLength`; after the merge there is one
  `startWordLength` (this one) and the draft-edit tests need re-running with it.
- `matchDraftEdit` is **not wired** into this `onResult`. After the merge it must move onto the
  settled-utterance side (plan "Order of checks": navigation → navigate → draft edits → gate →
  guard/pick → dictation). The seam is `UtteranceHooks.take` (below): a draft edit is an
  utterance that starts with the start word, so with hands-free on it needs to be *held* until
  it settles — today only `mayNavigate` utterances are held (start word alone, or + the
  navigate word). Either extend `StartLexicon.mayNavigate` to "may be any Tabby command" (cheap:
  hold every utterance whose first word is the start word) or accept that draft edits are
  matched on the first event's `insert` as in main. Decide at the merge.
- The merge conflict hot spots: `useVoiceInput.ts` (main edits `onResult`'s head; this branch
  moved the whole body into `consume(...)`), `voiceCommands.ts` (tail of file, `words()`),
  the five dictionaries near `voice.say.confirmPhrase` (identical `voice.startWord` line) and
  `untested.ts`.

### What landed

**1. Matcher** (`src/lib/voice/voiceCommands.ts`, pure; tests in `src/__tests__/terminal/VoiceCommands.test.ts`):

- `matchStartWord(utterance, lang) → { rest } | null`
- `matchNavigate(utterance, lang) → { rest } | null` — start word + a `voice.navigate` word,
  exact; `rest` is what follows as heard. Call on a settled utterance only.
- `mayNavigate(utterance, lang) → boolean` — the utterance so far may still become
  "start word + navigate …" (start word alone, + a prefix of the navigate word, or the whole
  navigate phrase and more). This is the hold-back predicate.
- `matchNavLeave(utterance, lang) → boolean` — whole utterance is a `voice.nav.leave` phrase,
  start word allowed in front, polite words ignored.
- "go to the done / working / waiting tab" (and "the done tab", "go to the next done tab", …)
  added as alternatives to `voice.cmd.nextDone/nextWorking/nextWaiting` in all five
  dictionaries; tests show they beat `goToTab` and `doneTodo`.

**2. Utterance layer** (`mobile-web/src/voiceInput.ts`, pure; tests in
`src/__tests__/mobile/MobileVoiceInput.test.ts`, 25 new): `scanDictation(event) → { heard,
interim, starts, tail, live }` (`readDictation` is now a thin wrapper, unchanged output),
`stepUtterances(ledger, progress, scan, lexicon, opts) → { ledger, progress, insert, preview,
bare, opened, held }`, `settleUtterances(ledger, progress, lexicon, opts, lastScan?)`,
`currentUtterance(scan)`, constants `UTTERANCE_SETTLE_MS` (800) and `GATE_WINDOW_MS` (10 000).
`mobile-web/src/startLexicon.ts` builds the `StartLexicon` (`start(words)`, `mayNavigate(words)`)
from the matchers for a language. With `gate`, `holdBack`, `capture` all false it is
`advanceDictation` (a test runs both side by side).

**3. Gate and cue**: `useTabbyGate(tabId)` (state: `on` ref, `line` "cue" | "listening", the
10 s window) wired through `useVoiceInput` (the gate, hold-back, settle timer, the cue after a
spoken send), `useHandsFree` (its pause-send and reopen clear the gate; toggling hands-free
clears it), `Terminal.tsx` (voice line shows `tabbyLine`, typing in the box clears the gate,
the mic tap starts with `{ gate: false }`). Tests: `src/__tests__/mobile/MobileTerminalTabbyGate.test.tsx`
(14, new file — not `MobileTerminalVoice.test.tsx`, which has no chime mock; that file is
untouched and proves hands-free off is unchanged).

### Interfaces N2 plugs into

- **Where utterances are routed.** `useVoiceInput.ts`, `onResult`: with hands-free on and the
  user not stopping, every reading goes `scanDictation → stepUtterances` (not
  `advanceDictation`); results then flow through the local `consume(insert, interim, preview,
  held)`, which is the old body (guard, `pick`, spoken send, draft, "Heard:") unchanged. The
  hands-free `guard`/`pick` therefore see only what the layer lets through — a held or captured
  utterance never reaches `guard.settled`/`pick` (it keeps speech "open" via `held`, so the
  pause does not run).
- **Hooks (new `useVoiceInput` param `utterances: UtteranceHooks`, created in `Terminal.tsx` as
  `utteranceHooks`):**
  - `capture: MutableRefObject<boolean>` — navigation mode sets it true: every *new*
    utterance is held until it settles, offered to `take`, and never typed (handled or not).
  - `take: MutableRefObject<(utterance: string) => boolean>` — called **once per held utterance,
    when it settles**, with the whole text as heard (including the start word). Return true if a
    command took it (not typed); false lets a held-but-unclaimed utterance be typed as heard
    (capture mode never types). N2: match `matchNavLeave` / `match(..., requireCommandWord:
    false)` / `matchConfirm` inside the mode, `matchNavigate` outside it, here. Today only
    utterances for which `mayNavigate` is true are held outside capture, so `take` currently
    sees exactly the "Tabby navigate …" ones (default `() => false`: they are typed after the
    settle, as plain text; N2 replaces that).
  - Entering navigation mode must also `guard.reset()` (plan: drop a pending guard window) and
    set `voiceOpen.current = false`; the hook does not.
- **Gate API (`TabbyGate`, `useTabbyGate`)**: `on` (ref), `line`, `windowOpen()`, `arm()` (gate
  on + chime + cue line), `set(on)` (gate without a cue — for a landing), `listen()`, `windowUsed()`,
  `clear()`. `startVoice(options?: { gate?: boolean })` (`StartVoiceOptions`, exported from
  `useVoiceInput.ts`): `{ gate: true }` for a landing/navigation start (sets the gate, no cue —
  N2 may want its own line), `{ gate: false }` for a tap and hands-free's reopen (both pass it
  now), omitted leaves the gate as is. `startVoiceRef` in `Terminal.tsx`/`useHandsFree` has the
  wider type. The gate is also cleared by the mic's end (`onEnd`), a stop, typing, and tab change.
- **`stepUtterances` options** N2 may need: `capture`, `open`, `onWithheld`; `settleUtterances`
  flushes. A navigation mode that ends itself inside `take` should clear `utterances.capture`
  *before* returning so the next utterance is judged normally.
- **Recognizer restart** (`onRestart`) settles the live utterance first (held words are offered
  to `take`, then typed if unclaimed), then resets the ledger; `stopVoice` settles before the stop.

### i18n keys added (all five dictionaries)

`voice.startWord` ("{assistant}"), `voice.assistantAliases`, `voice.navigate`, `voice.nav.leave`,
`mobile.voice.tabbyCue` ("Sent — say {assistant} for your next prompt"),
`mobile.voice.tabbyListening` ("Listening for your prompt"); and extra alternatives on
`voice.cmd.nextWaiting/nextWorking/nextDone`. **Not added (N2's)**: the navigation mode's lines
("Project {name}?", "No agent tab in {name}", "Nothing is working", "Navigation closed",
"You asked: {text}", …) — the plan listed them under step 1, but they depend on N2's exact
needs and the step table gives N2 the i18n files too.

### Untested rows

`mobile.voice.tabbyStart` in `src/lib/untested.ts` (placed before `mobile.voice.keepListening`,
not beside `spokenSend`, to stay clear of the main checkout's `draftEdits` row). Call site: the
voice line in `Terminal.tsx` (the pill shows beside the cue / "Listening" line). `mobile.voice.navigate`
is N2's.

### Gates

`scripts/gates.sh` with everything committed sees only docs, so it was run as
`scripts/gates.sh --base be8e75ab` on 5ecc8c88 (`--changed` vitest = every test related to the
19 changed files):

| gate | result |
|---|---|
| brand-check | pass |
| `git diff --check be8e75ab` | pass |
| `npm run lint` | pass (0 errors; only the existing `Terminal.tsx` exhaustive-deps warning, none new) |
| `npm run build` (tsc 7 + desktop, mobile, web bundles) | pass |
| vitest (821 related files) | **8142 passed, 3 failed** of 8145 |
| Rust gates | skipped: no Rust change |

Plus a clean full `src/__tests__/mobile` run: 2220 passed (2181 at the base; +39 = 25 utterance
layer + 14 gate). `VoiceCommands.test.ts` 92 (incl. the new block), `MobileVoiceInput.test.ts` 40,
`MobileTerminalTabbyGate.test.tsx` 14; the existing `MobileTerminalVoice`, `MobileTerminalHandsFree`
and `MobileTerminalReadAloud` files are green and unchanged.

The 3 failures, none from this work (checked in a detached worktree at be8e75ab, since removed):

1. `shell/i18n.test.ts > every language covers every English key` — fails at the base
   (es/fr/it/de miss `agents.tools.*`, `agents.defaultsCustomModel`, `agents.defaultsNoModels`).
2. `theme/CursorPacks.test.ts > reads the cursor tokens instead of naming a keyword a pack
   replaces` — fails at the base.
3. `mobile/MobileTerminalTranscript.test.tsx > keeps the chat while a /clear sent mid-turn waits
   behind the turn …` — a wall-clock flake: it counts websocket writes while the first click's
   `/clear` is still being typed on 150–200 ms timers (`sent.length` 4 vs 3). Passes alone and in
   most full `mobile` runs, fails under load. The base fails it too when two full `mobile` runs
   share the machine (both runs failed at be8e75ab). It failed in about half the full runs on
   this branch against none of four single-load base runs; likely the extra ~40 tests shifting the
   load, but rerun it once on a quiet machine before concluding.

### Gotchas

- **`unlockSpeech()` in the mic tap was NOT added** (plan step 3 lists it). Five existing
  hands-free tests in `MobileTerminalReadAloud.test.tsx` assert the list of spoken utterances is
  empty after a mic tap with hands-free on; `unlockSpeech()` speaks an empty utterance. Nothing
  speaks from the mic in N1, so N2 should add it with navigation mode (needed there), filtering
  `""` in those assertions or having `unlockSpeech` skip when something already spoke.
- The gate path (stepUtterances) is used only with hands-free on and the user not stopping;
  with it off `advanceDictation` runs exactly as before and the gate is cleared on every event.
- A held utterance is released on the **settle timer** (800 ms after the last result), which
  re-arms on every result. The timer tells `consume` the last reading's live interim, so a
  recognizer that stops with an interim open still counts as "speech open" for the send pause
  (`MobileTerminalHandsFree` tests depend on it).
- Gate verdicts are per utterance, keyed by where it starts in `heard`; a result list that
  starts over (Chrome after a pause) is detected by `resultListRestarted` (same rule as
  `advanceDictation`), which settles the old list's last utterance first.
- Hold-back only applies with hands-free on: with it off "Tabby navigate" is dictation (decision 8).
- `loadDict(spokenIn)` is called on each mic start so the start word and navigate phrases come
  from the *spoken* language's dictionary, not the screen's.

### Flagged for user

1. **Draft already under way opens the gate.** Plan decision 7 says an utterance must start with
   the start word. Chrome splits one spoken prompt into several utterances at every short pause,
   so literally applying it drops the second half of nearly every long prompt (and a separate
   "go on"). Implemented: while the draft is non-empty (or for 10 s after "Tabby" alone) the
   next utterance is kept without the start word; the gate still applies to the *first*
   utterance of a prompt. If you meant it literally, drop `|| draftRef.current.trim() !== ""`
   from `utteranceOptions` in `useVoiceInput.ts`.
2. **The start word is exact (phonetic spelling + aliases), not fuzzy.** The plan asks for a
   bar stricter than `NAME_FLOOR`; one letter off in four (0.75) accepts "taxi", "Toby", "tabs".
   Misspellings the recognizer is known to write live in `voice.assistantAliases` per language
   ("Tabbie", "Tavi", "Tebby" …). Real-world recall is the open question — extend that key if
   the phone writes something else; main's draft edits will get the stricter bar too.
3. **Hold-back delays "Tabby …" commands, not only navigation.** With hands-free on, "Tabby"
   alone is held until the next word (or ~0.8 s); "Tabby scratch that" is typed as "Tabby
   scratch that" and the draft-edit matcher (main) must be re-seated (see top).
4. **`unlockSpeech` and the nav lines are left to N2** (see Gotchas / i18n).
5. Tests for the pause-send and hands-free-reopen gate resets are not in the Terminal test
   file (they need a transcript/answer cycle); they are exercised only through the code path
   (`onSend`, `startVoiceRef.current({ gate: false })`). N2's landing tests are the place to
   cover `{ gate: true }`.

## N2 (plan steps 4–7) — done

Worktree `voice-nav`, on top of N1. Commits:

| sha | step |
|---|---|
| `2c08837f` | 4 — `voiceNav.ts` (lists, queues, cursor, landing note), `needsYouGroups.ts` lifted out of `NeedsYou.tsx`, **and the 15 i18n keys** (committed here by `git add -A`; they are used from step 5), plus the plan file itself (it was untracked in the worktree) |
| `6e569684` | 5 — navigation mode (`useVoiceNav.ts`), `useHandsFree` defers, `useVoiceInput` dispatch, `Terminal.tsx`/`App.tsx`, `unlockSpeech()` in the mic tap, `mobile.voice.navigate` row; also `landingRead` + its tests (pure, belongs to step 6) |
| `fe74f921` | 6 — `useVoiceLanding.ts` + landing tests |
| `79a38c22` | 7 — help page, `docs/context/voice.md`, file map, `phone_voice_plan.md` pointer, plan status + "Decided in the build" |
| `4219eb65`, `a602a31c` | test type fix; the N1 gate test's navigate case now answers the project fetch |

### What landed

- **`mobile-web/src/voiceNav.ts`** — `projectItems`, `detailLists`, `latestAgentTab`, `tabAtNumber`, `agentTabChoice`, `navQueue` (waiting = Needs you asking group, done = its finished group, working = `sortAgentTabs` lastWorking; unavailable tabs left out), `nextInQueue` + `noteJump` (module cursor, wraps, never the current tab), `leaveLanding`/`takeLanding` (one-shot, 30 s, other tab dropped), `landingRead`, `promptForVoice`.
- **`mobile-web/src/needsYouGroups.ts`** — the two Needs-you filters, used by `NeedsYou.tsx` and `voiceNav.ts`.
- **`useVoiceNav.ts`** — the mode (`off | open | confirm | pick`). Sets `utterances.capture` and `utterances.take`; `guard().reset()` + `voiceOpen=false` on entry. Commands run one at a time (promise chain). Lines are always spoken via `speak(..., replace)` with the mic closed (`endDictation()` in a microtask, so the utterance layer's step is not disturbed), mic reopened `NAV_TAIL_MS` (300 ms) after the voice is quiet; no speech output → line shown only, mic stays open. Idle close after `NAV_IDLE_MS` (10 s), armed only when not speaking. A mic tap calls `nav.end()`.
- **`useVoiceLanding.ts`** — takes the note in a mount effect; waits for `connected` and the transcript (6 s, then the tab row's `lastPrompt`); speaks "You asked: …", reads answers after it with `readTurn(tab, sinceKey)`; then `startVoice({ gate: true })`. Hands-free off or a mic tap first: the note is taken and dropped. Tapping the line stops the voice and opens the mic.
- **`useVoiceInput.ts`** — `dispatch(text)` is the single ordered route of a held utterance, and `consume` returns early while `utterances.capture` is set (so the send guard never runs in the mode).
- **`App.tsx`/`Terminal.tsx`** — `openTab(..., { project })`; a new optional `openProject(id)` prop (project with no agent tab → its screen).

### Where the merge of the draft edits slots in

`useVoiceInput.ts`, function `dispatch`, marked `// (3) the draft edits slot in here.` Order: `utterances.take` (navigation mode, then "Tabby navigate") → **draft edits** → (not claimed) gate → `consume` (guard, `pick`) → dictation. Two things the merge must do: (a) widen `StartLexicon.mayNavigate` (`startLexicon.ts`) to "any utterance that starts with the start word" so edit utterances are *held* until they settle (today only start word, + a prefix of the navigate word, or the navigate phrase are held); (b) call `matchDraftEdit` in `dispatch` after `take`, return true when it ran. Also drop main's own `startWordLength`/`matchStartWord` in favour of N1's exact one.

### i18n keys (all five dictionaries)

`voice.nav.project|noAgentTab|nothingWorking|nothingDone|nothingWaiting|notYet|closed|desktopDown|unavailable|noSuchTab|landed|youAsked|noAnswerYet|noAnswer` (spoken, in the spoken language via `translate`) and `mobile.voice.navOpen` (shown).

### Untested rows

`mobile.voice.navigate` in `src/lib/untested.ts`; call site: the nav/landing voice line in `Terminal.tsx`.

### Tests

`MobileVoiceNav.test.ts` (23), `MobileVoiceNavMode.test.tsx` (37: mode, project ask-back, three queues, tab by name/number/agent, leave/idle/tap, no-TTS, hands-free deferral with a mutation check, landing, draft kept). Changed existing tests: the five hands-free tests in `MobileTerminalReadAloud.test.tsx` now read `voiced()` (the spoken list without the empty unlock utterance) — same assertions; `MobileTerminalTabbyGate.test.tsx`: "Tabby navigate" is no longer typed after the settle (it opens the mode), so that test was split into a "Tabby nav" (prefix, typed) case and a mode-opens case.

### Gates

`scripts/gates.sh --base be8e75ab`: brand pass, `git diff --check` pass, `npm run lint` pass (0 errors, no new warnings), `npm run build` pass. Vitest (`--changed be8e75ab`, 823 files): **8204 passed, 2 failed of 8206** — the known base failures `shell/i18n.test` (`agents.*` keys only) and `theme/CursorPacks.test`. (A first run also failed the mobile gate test, fixed in `a602a31c`, and the desktop `TerminalAiSwitch` test, which passes alone and in the rerun: load flake.) `MobileTerminalTranscript` "/clear mid-turn" passed. No Rust change.

### Gotchas

- `scanDictation` reads two near-identical utterances in one result list as one revised utterance (`sameSpeech`: ≥60% of the earlier words in order). Real life separates navigation commands by a mic restart (the phone speaks between them, or a jump replaces the screen); tests use a fresh mic (`reopen()`).
- The socket's `visibilitychange` handler pings and abandons the link (mic aborted) after 4 s without a pong: tests that dispatch it must stay under that.
- `endDictation()` aborts the recognizer without `onEnd`, so the gate is not cleared by it.
- A landing starts the mic without a tap; a browser that refuses shows the existing failure line and the mic button works.

### Flagged for user

1. **Navigation closes with a shown line only** ("Navigation closed" for 3 s, plus the opening chime), not a spoken one, so the mic is not bounced; say if you want it spoken.
2. **Project list is `GET /projects?view=active`** (what Home shows); a project only reachable through Home's search is not nameable.
3. **"Cancel"/"stop" in the project ask-back leave the mode** (leave phrases win over "no"); "no" keeps it open.
4. **Landing on a shell tab** reads nothing, starts no mic, ends the mode (as planned); the line is not spoken because the screen is replaced.
5. **Not run live**: nothing here was started; the speech/recognizer interplay (mic reopen after a spoken line, the start word's real spellings, Chrome re-finalization) is only covered by fakes.
6. `todo/*.md` has no phone-voice 🖐️ entry to extend; the Untested register rows (`mobile.voice.navigate`, `mobile.voice.tabbyStart`) are the manual list.

## N3 review (bugs only) — done

Worktree `voice-nav`, on top of N2. Read against the plan's fixed decisions 1–10 (none changed).

### Fixed (each with a regression test that fails without it)

| sha | bug |
|---|---|
| `1626ce27` | `useVoiceLanding`'s `gone` flag was set by the cleanup of a first setup and never reset: under a development remount (StrictMode) the landing never spoke and the mic never opened. |
| `2d95baa2` | Navigation's 10 s quiet timer kept running while a command was being said: a command begun at 9.5 s settles 0.8 s later, after the timer had left the mode, and was dropped. The recognizer's words now start the 10 s over (`UtteranceHooks.activity`, only while the timer is armed, so a spoken line or a command in flight is untouched). |
| `0d73314f` | `lastScan` (the last reading's live guess) survived a mic start: stopping a fresh mic before it heard anything settled the old mic's guess back onto the Heard line. Hands-free off never had this (the settle path is hands-free only); it was new with the utterance layer. |

### Gates

`scripts/gates.sh --base be8e75ab` (31 files, frontend only): brand pass, `git diff --check` pass, `npm run lint` pass (0 errors, no new warnings), `npm run build` pass. Vitest (823 related files): **8207 passed, 2 failed of 8209** — the known base failures `shell/i18n.test` (`agents.*` keys) and `theme/CursorPacks.test`; no flake this run. +3 tests over N2 (8204 passed). No Rust change. (The run reported "tree changed" only because this section was written while it ran.)

### Checked, no bug found

Hands-free off is the be8e75ab path (`advanceDictation`, `consume` without guard, `onRestart`/`stopVoice` settle return early; the gate is only cleared; the one visible addition is the silent `unlockSpeech()` in the mic tap, which the plan asks for). `loadDict` never rejects, so `load()` cannot cache a rejected promise. `onEnd` never follows `abort()`, so a half-duplex `endDictation` cannot clear the next session's gate. Every `handle` path ends in `say(... "listen")`, a jump or `armIdle`, so the mode has no open path without a timer, except a hanging `fetch` (`api` has a timeout). `takeLanding` takes once, drops another tab's and a stale note; the Terminal unmount releases `holdReadingForTurn`. No hardcoded display text, no assistant name in code, no ids crossing `mobile_control`, both untested rows have call sites.

### Flagged for user

1. **A settled utterance that keeps growing is dropped.** The 800 ms settle hands "Tabby navigate" (or "go to project") to the mode, marks the record handled, and any later growth of the same recognizer utterance (a pause under Chrome's own end-of-speech, so "Tabby navigate … [1 s] … go to the done tab" is one utterance) is skipped. With the gate off, "Tabby" + a pause + "navigate" types "Tabby" into the draft after the settle and then "navigate" as well. Fix needs the layer to re-offer a handled utterance's new tail; not done blind. Worth a live check of how often Chrome splits there.
2. **A question read aloud while navigation is open.** `useHandsFree`'s question effect (hands-free + read-aloud) does not defer to `navOpen`: it closes the mic and speaks the question, the mode's 10 s timer can then `leave()` and reopen the mic while the phone is still reading (echo), and the nav lines' `speak(..., replace)` cut the question off. Rare (a question has to arrive while the mode is open); no hands-free question test exists to anchor a fix.
3. **No line says "say Tabby" after a landing or a leave**, though the gate is on (`tabbyGate.set(true)` shows no cue); the user's first words without it vanish with no sign. A shown cue there is a one-liner if wanted.
4. **A dead session's settle timer** is not cancelled by `endDictation()` (only `onEnd`/unmount clear it); it fires once on the old closure. With `lastScan` now cleared at a start the effect is limited to `voiceOpen`/guard state for a closed mic, but a `recognition.current === session` guard in `settle` would be tidier.
5. **Two utterances finalized in one event** are judged with the `capture` flag as it was at the start of the step, so a command finalized in the same event as "Tabby navigate" is typed or dropped by the gate. Needs interim-first recognizers to hit; `capture` could become a function.
6. **Words in flight when the mic is tapped off** (nav open, or gate on) finalize after the stop through the plain `advanceDictation` path and are typed raw.
7. **No safety net for a voice that never ends**: if `speechSynthesis` fires neither `onend` nor `onerror`, the mode's mic (and the landing's) never reopens; the voice line's tap is the way out.
8. **A tap on the mic while the phone speaks a nav line** ends the mode and stops the voice but needs a second tap to open the mic.
9. **`openProject` in `App.tsx`** does not `setTab("projects")`; if a Terminal was ever opened from another section, "no agent tab" would show that section, not the project.
10. **Landing with a kept draft** starts the mic with `{ gate: true }`; the plan lists "a draft already present at a landing" among the gate-off cases. The effect is the same (an existing draft already lets the next utterance through), only the gate flag differs.
11. **Words**: French `voice.cmd.nextWorking` "l'onglet en cours" also reads as "the current tab"; the alias "tabe" plus the two-word join lets an utterance starting "tab be …" match the start word (rare).
12. **Leaving Focus by Back** while a nav or landing line is being spoken does not stop the voice.

## N4 fixes (the N3 "Flagged for user" items 2-12) — done

Item 1 (an utterance growing past the 800 ms settle) is deliberately left flagged: it needs a live check.
Each fix has a regression test that fails without it, except item 12.

| Item | sha | Fix |
|---|---|---|
| 4 | `793e3584` | `endDictation` clears the utterance layer's settle timer (now one ref shared by `useComposer` and `useVoiceInput`); unmount already cleared it. |
| 5 | `4b7b8fe5` | `UtteranceOptions.gate` / `.capture` may be functions, asked as each new utterance begins, so a second utterance in one event is judged by the mode the first left. |
| 6 | `8042bee4` | After a stop, in-flight words go through the layer as the mic stood at the stop (gate, capture). Navigation-mode words are dropped, a navigate phrase opens nothing, held words settle at `onEnd`. `stopVoice` now runs before `nav.end()` in the mic tap. |
| 8 | `77810e58` | A tap with navigation open stops the voice and goes on to start the mic. |
| 7 | `c6323d5c` | `speechOutput.guardSpeech`: a piece that has not moved for 15 s + 100 ms per character is stopped (each chunk restarts the watch). Used by the nav line wait and the landing wait. |
| 12 | `aa3eafbc` | Already true: `useReadAloud`'s unmount cleanup calls `stopSpeaking()`. Two tests added to lock it in; no source change. |
| 9 | `55e7f209` | `openProject` in `App.tsx` also calls `setTab("projects")`. |
| 3 | `2c288d03` | `tabbyGate.set(true)` shows the existing cue line (no chime). Its wording is "Sent — say Tabby …", slightly off after a landing or leave; a dedicated key would be a five-dictionary addition if wanted. |
| 10 | `0a8a1eac` | The plan is explicit ("also a draft already present at a landing" is a gate-off case), so a landing with a draft opens the mic with the gate off. Leaving navigation keeps the gate on, as the plan says. |
| 2 | `de3d9d83` | The question read-out in `useHandsFree` waits while `navOpen` or `preparingVoice` and runs again after. A landing needed nothing: its question queues behind the landing lines. |
| 11 | `87706aee` | Two words run together match only the name's own spelling, not an alias ("tab be" no longer); French `l'onglet en cours` and Italian `la scheda in corso` (a sibling collision) are no longer bare working-tab phrases ("qui travaille" / "che lavora" stand in). Near-miss tests in all five languages. |

### Gates

`scripts/gates.sh --base be8e75ab` (35 files, frontend only): brand, whitespace, `npm run lint`, `npm run build` pass. Vitest (825 related files): 8231 passed, 2 failed of 8233 — the known base failures `shell/i18n.test` (`agents.*` keys) and `theme/CursorPacks.test`. No flake this run. No Rust change.

### Could not fix

Item 1 only (see top). Note the tap-off routing (item 6) is covered with a fake recognizer that finalizes words inside `stop()`; the real Chrome order of final results, `onend` and restart is unchecked live.
