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
