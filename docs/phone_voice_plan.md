# Phone hands-free voice: steering everything while cooking or driving

Status: plan only (2026-10-28), reviewed against the code the same day.
Nothing of this plan is built. It builds on the phone's Focus hands-free
loop that landed with `docs/desktop_voice_plan.md` step 5 (commit
76ea8097, not run live). It draws on three read-only research reports from
that day: the existing voice stack, the phone's steering surface, and the
hands-free loop's platform limits.

Related plans: `docs/desktop_voice_plan.md` (desktop dictation, read-aloud,
hands-free; its step 5, the phone's Focus loop, is built, and its step 10 is
the phone as the desktop's mic), `docs/voice_navigation_plan.md` (desktop
voice commands; its matcher, step 2, is built here once for both),
`docs/mobile_speech_plan.md` (phone audio → desktop whisper; becomes step 9
here). Design notes: `docs/context/voice.md`.

## Why

What the phone does today (all in `mobile-web/src`):

- Dictation into the Focus composer: `voiceSession.ts` (`startDictation`,
  restarts the recognizer through pauses, wake lock while dictating, 120 s
  idle end) and `voiceInput.ts` (on-device check, result reading).
- "go on" / "los" sends (`shared/voice.ts` `spokenSend`).
- Read-aloud of each new answer (`speechOutput.ts`, a flat queue of
  `speechChunks`; `screens/terminal/useSessionChat.ts` `useReadAloud`, per
  answer entry, not per turn).
- The Focus menu's **Hands-free** row (`focusHandsFree`, untested pill
  `mobile.voice.handsFree`): a pause sends through the shared send guard
  (`shared/handsFree.ts`, chime + ~1.5 s cancel window), and the mic opens
  again once the turn is over and the answer read
  (`screens/terminal/useHandsFree.ts`, `mobile-web/src/handsFree.ts`
  `handsFreeTurnOver`). A question card is read out and "two" picks its row
  (`voicePick`, `matchOption`).

Everything else still needs a finger: arming the mic outside one Focus
screen, switching tab or project, a new tab, permission prompts done safely,
mail, calendar, to-do, and unlocking the app after 3 minutes without a touch.
The loop also lives in one Terminal screen: the recognizer is aborted on
every tab change (`screens/terminal/useVoiceInput.ts:193-202`).

The goal is to steer **everything** in Tabtivity by voice from the phone
while the hands are busy. Two scenarios set the requirements:

- **Cooking.** The phone stands on the counter, screen on, probably plugged
  in, on the open speaker. Earbuds are optional. The extractor fan is loud,
  and the session lasts an hour.
- **Driving.** The phone sits in a mount, and audio goes over car Bluetooth
  or the speaker. The screen must never be needed. There is road noise, and
  the link drops in tunnels.

On top of that, read-aloud has to be **efficient and navigable**: read the
next part, skip this answer, go back, repeat, read faster, summary first.

## What a PWA can and cannot do (research findings, unprobed)

- **The screen must be on and Tabtivity in front.** A hidden page loses Web
  Speech, the wake lock and reliable mic access. On iOS the mic stops when
  the page is backgrounded, and home-screen apps get no Web Speech at all.
  Pocket use, a locked phone, or a navigation app in front means **no
  listening**. The desktop plan already rules a native app out of scope for
  this (`desktop_voice_plan.md` step 5).
- **Opening the mic switches the car to call mode.** With a Bluetooth mic
  open, Chromium puts Android in communication mode: A2DP becomes HFP, the
  music mutes, and the head unit shows a call. Always listening through the
  car is therefore out, and each car turn is short and triggered.
- **Earbud and steering-wheel buttons reach the page through Media
  Session.** That works only while the page holds media focus (a looping
  silent `<audio>`, started by one tap) and only over A2DP. Under HFP the
  buttons turn into call controls.
- **Echo.** Chrome's recognizer is not echo-cancelled against
  `speechSynthesis`. On the open speaker the phone hears itself, so the mic
  is closed while it speaks (half-duplex, the desktop plan's default). With
  earbuds, barge-in is possible.
- **Android Auto and CarPlay** take native apps only. A web app or a TWA
  cannot appear there.
- **Wake words.** openWakeWord's pretrained models are CC BY-NC-SA.
  Porcupine needs a phone-home key, and its free tier reportedly ended
  2026-06.
- **Noise.** An energy-based VAD treats an extractor fan as constant
  speech. A neural VAD such as Silero (`@ricky0123/vad-web`, MIT) helps
  once audio goes to the desktop (step 9).
- **The phone's CSP** (`services/mobile_control/host.rs`, the non-desktop
  branch) has no `media-src`, so `default-src 'self'` applies: a silent
  loop from a `data:` or `blob:` URL is blocked. A `'self'` file works, and
  so should an `<audio>` whose `srcObject` is a Web Audio
  `MediaStreamDestination` (no URL is fetched). The probe decides which.

## Fixed decisions (the user's, 2026-10-28)

1. **Trigger: an armed session plus a command word.** One tap arms a
   hands-free session, with the screen on and a visible pill. While the
   session is armed:
   - An utterance that starts with the command word is a command.
   - After every spoken reply the mic stays open for a **follow-up window**
     (~8 s), in which commands need no command word.
   - An earbud or steering-wheel button (Media Session) also opens a turn.
   - There is no wake-word model.

   This **reopens** two earlier decisions for the phone: the navigation
   plan's "push-to-talk, no always-open mic" (D1) and "phone later" (D4).
   The desktop keeps push-to-talk.
2. **Car: the PWA now, a native companion later.** A driving mode in the
   PWA covers the phone mounted, the screen on and Tabtivity in front.
   - Spoken output is short, and destructive commands are refused.
   - A small native **Android Auto messaging companion** is a later,
     optional phase with its own plan (step 11). It lets the car read agent
     questions and "done" events aloud, and the user replies by voice.
3. **Agent permission prompts by voice: in the kitchen yes, while driving
   no.**
   - **Kitchen:** the full question and options are read out, then a spoken
     "yes" confirms. Broad options ("always allow", "don't ask again") are
     never picked by voice.
   - **Driving:** plain questions can be answered. Permission and diff
     approvals answer "Look when you're parked".
4. **The idle lock is held off while a session is armed.** The 3-minute
   local lock (`mobile-web/src/App.tsx:79` `LOCK_AFTER_IDLE_MS`; the timer
   is the lock effect in `App.tsx`, and `localLock.ts` holds the PIN and
   biometric unlock) is suspended while a hands-free session is armed. The
   lock comes back when any of these happens:
   - the user ends the session;
   - **30 min pass without a recognized utterance**;
   - the page is hidden.

   Re-arming after a lock needs the normal unlock.

5. **Personal safety phrases (the user's, 2026-10-28).** In Settings →
   Voice (phone) the user can define their own words, so that a radio, a
   TV or another person in the room cannot steer or approve anything:
   - **Personal command word.** It replaces the i18n default
     `voice.commandWord`. It is stored per device.
   - **Personal confirm phrase.** When it is set, every **C** command and
     every permission approval accepts only this phrase instead of a plain
     "yes" / "ja". Saying "yes" then answers "Say your confirm phrase".
     When it is not set, "yes" works as described below.
   - Both are checked as whole utterances, matched more strictly than
     command slots (normalized exact match, no fuzzy margin). Both stay
     local to the phone and are never spoken back or logged.
   - The settings screen warns when a phrase is a common word or a
     catalog phrase, and offers a short test ("say it three times") to
     check that the recognizer hears it reliably.

## Inherited decisions (from the desktop plans, unchanged)

- **Send guard (desktop D3).** A hands-free send plays a chime, then holds a
  ~1.5 s window in which "stop" / "stopp" cancels it. "Go on" / "los" sends
  at once. Built: `shared/handsFree.ts` `createSendGuard`; reused as is.
- **Half-duplex on the speaker.** Captured audio is dropped while the voice
  speaks, plus a 300 ms tail.
- **No model in the loop.** Matching is deterministic. Arguments come only
  from live lists, never free text. An ambiguous match asks back, and an
  unmatched utterance gets "Didn't catch that" and is never typed anywhere.
- **Destructive commands confirm by voice.** The target is read back,
  followed by "say yes", and one 5 s listen. Anything other than yes
  cancels.
- **Every guard still applies.** The AI switch ⏻, `ai_off_guard` on the
  agent routes, and the `mobile_control` invariant (only opaque ids cross;
  names resolve on the phone over lists it already has) all stay in force.
- **Voice never types into a shell**, settings or paths.

## Defaults decided here (the user may override)

- **Architecture A first, with a seam for B** (see Shape).
  - Recognition runs on the phone (Web Speech), on-device where available.
  - Hands-free honours the existing on-device/remote preference
    (`prefs.ts` `voiceRemote`) and opens no new cloud path.
  - Desktop whisper (B) plugs in later behind the same engine interface.
- **Opt-in, the phone's stand-in for `useExperimental`.** The phone has no
  experimental flag (`desktop_voice_plan.md` step 5 hit the same). A new
  switch **This device → Voice → Hands-free commands** (`MobileFlag`
  `handsFreeCommands`, off unset, untested pill) turns this plan on.
  - Off: the Focus menu's Hands-free row works exactly as today.
  - On: that row and a new arm button in the App shell both arm **one**
    App-level session. There is no second, parallel hands-free mode.
  - Arming is per page life and per tap (decision 1). It is never restored
    from storage: arming needs the tap to unlock speech and audio.
- **One session, one recognizer.** While armed, the App-level session owns
  the only `startDictation`. A mounted Focus screen gets its utterances from
  the session (`useVoiceInput` becomes a consumer), and never starts a
  recognizer of its own.
- **Voice steers the phone's own screens.** "Show ‹project› on the desktop"
  uses the existing `POST /projects/{id}/activate`, **without** `?tab=`
  (with a tab named, the desktop may respawn an agent tab for the phone,
  `wrapAgentTabForPhone`). Focusing a desktop tab or opening desktop
  overlays needs new `DesktopRequest` variants (step 10, later).
- **The command word is one i18n key shared with the desktop**
  (`voice.commandWord`), so it is the same word on both. It must not be
  "Tabby", because Tabby is the assistant's name. Its default is `{app}`, the brand
  name (answered question 3); the probe measures how well it is heard.
- **Language.** The matcher's templates and every spoken line use the
  phone's **speech language** (`speechLang.ts` `readSpeechLang`), not the UI
  language: someone may read English and talk German. Lines are built with
  `translate(lang, key)` from `src/lib/i18n`. Its non-English dictionaries
  load lazily for the UI language only, so step 1 exports a small
  `loadDict(lang)` from `src/lib/i18n/index.ts`.
- **Spoken names** are matched by a normalized edit distance per word (plus
  `fuzzyMatch`'s subsequence score from `src/lib/fuzzy.ts` as a tiebreak).
  `fuzzyRank` alone does not fit: it returns no scores for a floor and a
  margin, and a subsequence match fails on a misheard letter ("alfa" vs
  "Alpha").
- **The idle-lock hold, concretely** (decision 4):
  - While armed, a recognized utterance counts as activity (it moves
    `lastActive`), and the lock's limit is `HANDS_FREE_LOCK_MS` = 30 min
    instead of 3 min.
  - On session end or when the page is hidden, the session disarms (a
    hidden page has no mic) and the 3-minute rule is back, counted from the
    last touch or recognized utterance (answered question 2).
  - A lock ends the session. Re-arming needs the unlock and a new tap.
- **Personal phrases** are `MobileChoice` entries (`voiceCommandWord`,
  `voiceConfirmPhrase`) in `prefs.ts`. They are the owner's, like
  `speechLang`, so they survive an unpair (`forgetDeviceData.ts` leaves
  them). They never go into `traceConnect`, an error message, a toast, or
  a spoken line.
  - "Common word" warning, without a word list: a single word under 6
    letters, or any word that is a catalog template word, a stop, yes, no
    or number word in the speech language.
- **Read-aloud navigation:**
  - "next" / "weiter" means the next section.
  - "next answer" / "skip this answer" means the next answer.
  - Brief mode (headings plus first sentences) is the default in driving
    mode and a setting in kitchen mode.
  - A model-written summary is later, opt-in, and off with ⏻.
  - The read position per tab is kept in memory (module state), so it
    survives reconnects and tab switches but not a reload. It holds tab
    ids, so it is never written to storage.
- **No link (tunnel):**
  - One "link lost" earcon, then silence.
  - Commands that need the desktop answer "No connection". They are never
    queued.
  - A dictated draft is kept (`drafts.ts` already keeps it per tab). After
    reconnecting, the phone asks "Send your message to Claude?" and waits
    for yes or no.
  - The read-aloud position per tab is remembered, so nothing is read twice
    or skipped.
- **Announcements of other tabs:** an earcon plus "Claude in Alpha is
  asking" or "Codex in Beta is done". They are spoken only between
  utterances, never over dictation. Question and done events are on;
  working-state changes are off.
- **The landing line never calls `getAgentStatus`** (`GET
  /tabs/{id}/status`): its report may run the CLI for its usage panel. It is
  built from the catalog's `TabRow` state and, on a mounted Focus screen,
  the live busy row.
- **Earcons** extend `src/lib/voice/chime.ts` (`playChime(kind)`), shared
  with the desktop, synthesized with Web Audio, no audio files.
- **The probe page is dev-only in practice:** a lazy chunk opened by
  `?voiceProbe`, rendered only while the desktop's "Show untested tags" is
  on (the flag the phone already caches, `App.tsx:124`), never in a menu,
  never calling the API, and **deleted** in agent step S11 once its results
  are recorded here. A build-time switch does not work: the phone always
  runs the bundle baked into the binary (`docs/context/dev_builds.md`).

## Shape

```
 tap "Hands-free" (App shell or Focus menu, handsFreeCommands on)
   ─▶ handsFreeSession (mobile-web/src/handsFreeSession.ts, App level)
   │  wake lock (holdScreenAwake) · idle lock held off · Media Session
   │  silent loop (mediaSession.ts) · earcons (chime.ts)
   ▼
 SpeechEngine (interface) ── WebSpeechEngine over voiceSession.ts (now)
   │                        └ DesktopWhisperEngine (step 9)
   │ final utterance
   ▼
 state: Idle ─cmd word─▶ Command   Engaged (follow-up window) ─▶ Command
        Dictating (Focus screen consumes) ─cmd word at start─▶ Command
        Reading (speechOutput cursor) ─nav word / button─▶ cursor move
        Confirming (5 s yes / confirm phrase)
   │
   ▼
 voiceCommands.match(text, lang, liveLists)   ← src/lib/voice/, shared with desktop
   │ command │ ambiguous │ nothing
   ▼
 handsFreeDispatch.run(cmd)  (App navigator + api.ts; existing routes only)
   │                         tab-scoped commands → TerminalVoiceHandle
   ▼
 landing line / list read-out / reading cursor ─▶ speechOutput (half-duplex)
```

The matcher (`src/lib/voice/voiceCommands.ts`) and the reading model
(`shared/voiceReading.ts`) are pure modules shared with the desktop. The
dispatcher is phone-only, because the desktop's `appCommands` (navigation
plan step 1) is tied to Zustand and `useKeyboard`. Both dispatchers use the
same command ids (`VoiceCommandId`, defined by the matcher).

A mounted Focus screen registers a `TerminalVoiceHandle` with the session:
its dictation sink, question pick, model picker, interrupt and undo-clear.
Commands that act inside a tab (answer a card, model, stop agent) open that
tab first and wait for its handle, because the live screen state
(`useLiveQuestion`, `useModelPicker`) exists only while the Terminal is
mounted.

## Command catalog (first version)

Risk levels: **S** safe, **C** confirm by spoken yes, **N** never by voice.
Phrases are examples; each language gets its own `voice.cmd.<id>`
templates. All five dictionaries need every key (`src/__tests__/shell/
i18n.test.ts`); English and German are written with care first, and es, fr
and it get their own phrases in the same step.

| Spoken (EN / DE) | Does | Route | Cook | Drive |
|---|---|---|---|---|
| "projects", "home" / "Projekte" | Projects section | client | S | S, reads top 5 |
| "project ‹name›" / "Projekt ‹name›" | open project | `GET /projects/{id}` | S | S, tab count + states |
| "show ‹project› on the desktop" | desktop switch | `POST /projects/{id}/activate` (no `?tab=`) | S | S |
| "what's waiting" / "was wartet" | spoken Needs-you, paged | `GET /activity`, `GET /alerts` | S | S |
| "next waiting" / "next done" | open that tab, read its question / last answer | `/activity` → Terminal | S | S |
| "tab ‹n›", "‹agent› tab", "second Claude" | open tab | catalog → WS | S | S |
| "next" / "back" / "that one" (in a list) | pager over the last spoken list | client | S | S |
| "new ‹agent› tab [in ‹project›]", "new shell" | create | `GET launch-options` + `POST /projects/{id}/tabs` | S (shell C) | C |
| "tell ‹agent› …", "dictate", ending "go on" | dictation, send guard | WS / `POST /tabs/{id}/held` | S | C, read back first |
| "stop" / "stopp" | stop speech or a pending send; "stop agent" interrupts | WS interrupt | S | S |
| "option two", an option's words | answer a question card | WS via `useLiveQuestion` | C | C, plain questions only |
| permission / diff approval | as above | WS | C, no broad options | N |
| "model ‹name›" / "Modell ‹name›" | `/model` via the picker, arrows + Enter | WS | C, warns "becomes your default" | N |
| "close tab" / "Tab schließen" | close | `DELETE /tabs/{id}` | C | N |
| "reopen" / "wieder öffnen" | reopen last closed | `POST /projects/{id}/tabs/reopen` | S | C |
| "undo clear" | undo `/clear` | `POST /tabs/{id}/undo-clear` | C | N |
| "status", "where am I" / "wo bin ich" | landing line | catalog rows (never `/tabs/{id}/status`) | S | S |
| "mail", "read my next mail" | sender + subject, body on request | `GET /mail`, `/mail/folders/{f}/messages/{m}` | S | body C |
| "flag", "mark read" | mail mark | `POST …/messages/{m}/mark` | S | S |
| "reply …" / "antworte …" | reply (dictated body) | `POST …/messages/{m}/reply` | C, full read-back | C, full read-back |
| "what's today", "next event" | calendar read | `GET /calendar?month=` | S | S |
| "new event ‹when› ‹title›" | create event | `POST /calendar` | C | C |
| "new to-do ‹text›", "done ‹card›" | to-do | `GET`/`POST /todo` | S / C | C |
| "calendar / to-do / mail" | section switch | client | S | S |
| "load / unload model ‹m›" | local models | `/local-models` | C | N |
| git, diffs, commit, upload, sign-in, teleport, worktree move, schedules edit, any delete, shell input | — | — | N | N |

All routes are under `/api/v1` and exist today. The mail reply body, a
to-do text and an event title are dictation (free text), so each is read
back in full before the confirm.

Gaps the catalog needs filled, all phone-side:

- an app-level listener (today the mic belongs to one Terminal screen and
  is aborted on tab change, `useVoiceInput.ts:193-202`);
- "next waiting" ordering over `/activity` (reuse `shared/agentSort.ts`);
- spoken list paging;
- a spoken confirmation (`components/ConfirmSheet.tsx` is tap-only);
- a permission-prompt classifier and a broad-option filter. Today
  `voicePick` (`mobile-web/src/handsFree.ts`) picks **any** numbered row,
  broad ones included. That is a bug against decision 3 once this plan's
  session is armed, and agent step S5 fixes it;
- the model picker driven by arrow keys, never digits (a digit commits and
  rewrites Claude's global default).

## Read-aloud: efficient and navigable

**Reading model** (`shared/voiceReading.ts`, pure, shared with the
desktop's TTS; the desktop's `src/components/terminal/ReaderReadAloud.ts`
keeps its own flat chunks until a desktop follow-up adopts it):

- An answer becomes an outline: sections at headings, then paragraphs and
  list items, then chunks of at most 220 characters (`speechOutput.ts`
  `MAX_CHUNK`). Chrome on Android cuts an utterance off at ~15 s, so chunks
  stay short.
- A cursor marks the position: answer → section → chunk.
- `speechOutput.ts` moves from a flat queue to this cursor and keeps its
  `generation` counter for cancelling on jumps. Its exports `speak`,
  `stopSpeaking`, `unlockSpeech`, `currentSpeechId`, `subscribeSpeech` keep
  their meaning, so `useHandsFree.ts` and `components/MessageMenu.tsx` keep
  working unchanged.

**What is not read unless asked:**

- code blocks: "code block, 12 lines";
- tables: "a table, 6 rows";
- long lists: the first 3 items, then "and 5 more";
- paths: the file name only;
- URLs;
- tool calls and tool output (only the agent's own message is spoken;
  `transcriptTurns` already gives answer turns only).

The labels are passed in by the caller (i18n), so the module stays free of
i18n, like `shared/voice.ts`.

**Brief mode** says which agent answered and the answer's length, then each
heading with the first sentence of its section. "Read all" reads the full
text. The "summary" command, without a model, reads the agent's own closing
"Summary" / "In short" section if one exists, and otherwise the headings.

**Commands while reading.** The whole utterance must be the command (the
`isStopWord` rule), so dictation that merely contains these words never
triggers them.

| Spoken (EN / DE) | Effect |
|---|---|
| "next" / "weiter" | next section |
| "next answer", "skip this answer" / "nächste Antwort", "überspringen" | next answer, or stop if there is none |
| "back" / "zurück" | previous chunk; twice, the previous section |
| "repeat" / "nochmal" | current chunk again |
| "faster" / "slower" / "schneller" / "langsamer" | rate step, persisted |
| "summary" / "Zusammenfassung" | brief mode for this answer |
| "read all" / "alles lesen" | full text |
| "read the code" / "Code vorlesen" | the skipped code block |
| "where" / "wo" | "answer 2 of 3, section 2 of 4" |
| "stop" / "stopp" | stop reading |

**How the commands are heard while the mic is closed during speech:**

1. **Hardware buttons (Media Session).** next track → next section,
   previous track → back, play/pause → pause or resume. The lock-screen
   card shows "Claude · Alpha · 2/4". This is the best option with earbuds
   and on the steering wheel (A2DP only).
2. **Listening gaps.** After each section (or each chunk, as a setting),
   the mic listens for ~1 s for a navigation word. The recognizer keeps
   running and its results are dropped while speech plays plus the tail,
   which avoids the restart cost and the beeps. This is the default for the
   kitchen speaker. In the car it holds HFP open, so driving mode uses
   gaps at sections only.
3. **Headset barge-in.** With earbuds the mic stays open during speech and
   accepts only navigation words. Echo-text suppression drops any heard
   text that matches the chunk being spoken.
4. **Barge-in on the open speaker** needs the desktop plan's phase 2
   (Piper PCM played through Web Audio, removed by `getUserMedia`'s echo
   canceller). That is later.

A large tap target anywhere on the screen stays as a fallback in every mode.

## Modes

| | Kitchen (default) | Driving (toggle) |
|---|---|---|
| Output length | full answer minus code/tool output; brief is a setting | brief; ≤ ~2 sentences or ~15 s per item; longer: "Claude answered, about 40 lines — say summary or later" |
| Question cards | question + all options | question + ≤ 3 options; more → "look when parked" |
| Destructive | C | N |
| Permission approval | C, no broad options | N |
| Listen gaps | every section | sections only (HFP cost) |
| Follow-up window | ~8 s | ~8 s, earcon at open and close |

A PWA cannot detect driving, so the mode is a toggle on the hands-free pill
and is remembered (`MobileFlag` `voiceDriving`).

## Steps

Each step names its agent step (S0–S11, see Organisation).

### 0. Probes on the user's phone (S0 builds the page; the user runs it)

S0 builds the probe page: `mobile-web/src/voiceProbe.tsx`, a lazy chunk
that `main.tsx` renders instead of `App` when the URL has `?voiceProbe`
and the cached "show untested tags" flag is on (defaults above). It calls
no API and needs no pairing. Each check has a Start button (the gesture),
logs timings and events on screen, and ends with a Copy results button.
Its strings are plain English in the file: it is a developer tool that
never ships in a menu and is deleted in S11 (an exception to the i18n
rule, recorded here). No untested row.

The page reaches the phone with the next frozen dev build the user
relaunches (agents never relaunch). The user runs it once in the kitchen
and once in the car, and the main loop records the results under "Step 0
results" below.

1. Can `SpeechRecognition` be restarted by code after TTS ends, with no
   gesture, for minutes on end? Measure the beeps and the gaps of
   continuous on-device recognition. Can it instead keep running through
   `speechSynthesis` (results dropped), for 10 minutes?
2. Does the recognizer hear the phone's own `speechSynthesis` on the
   speaker? Can `start(track)` with an echo-cancelled `getUserMedia` track
   reach on-device recognition, and does that help?
3. Does a silent looping `<audio>` keep Media Session focus while
   `speechSynthesis` speaks? Try both sources: `srcObject` from a Web Audio
   `MediaStreamDestination`, and a `'self'` silent file (S0 adds
   `mobile-web/public/silence.wav`, a few hundred bytes, with its blob id
   in `scripts/privacy-reviewed-binaries.txt`). Do the earbud and
   steering-wheel buttons arrive, and what happens to them once the mic
   opens (HFP)?
4. Car: which mic does Web Speech use (the car's HFP mic or the phone's)?
   How does the A2DP↔HFP switching sound per turn?
5. How often does the extractor fan cause false triggers with each
   candidate command word?
6. Does `getUserMedia` or the recognizer survive the screen turning off?
   (The expected answer is no. This confirms the limit.)
7. Command word candidates (answered question 3: `{app}` first): say each one 10 times at
   1 m and 3 m, fan on and off. Record how often the recognizer writes it
   as one recognizable token.

**What the results gate:**

| Agent step | Needs results? | Which |
|---|---|---|
| S0, S1, S2, S6 | no | — |
| S3 session core | **yes** | 1, 2, 6: restart policy, idle behaviour, drop window |
| S4 App shell | **yes** | 3: silent loop source, whether buttons work at all |
| S5, S7, S8, S9 | no, but they follow S3/S4 | — |
| S10 driving | **yes** | 3, 4: HFP cost, gaps in the car |
| S1's default command word | **yes** | 5, 7 (the user picks from the measurements) |

S1 can land with a placeholder value for `voice.commandWord` and the final
word set after the probe; nothing else in S1 depends on it.

#### Step 0 results

Not run yet.

### 1. Shared matcher (S1) and reading model (S2), pure

**S1 — `src/lib/voice/voiceCommands.ts`** (the navigation plan's step 2,
built once):

- `VoiceCommandId`: the catalog's ids, shared with the desktop's future
  `appCommands`.
- `voice.cmd.<id>` templates (`|`-separated, slots like `{project}`,
  `{tab}`, `{agent}`, `{model}`, `{n}`) and `voice.commandWord`, in all five
  dictionaries. Also the yes / no words (`voice.confirmYes`,
  `voice.confirmNo`), the reading commands (`voice.read.<id>`) and the
  spoken lines the matcher returns (`voice.say.*`: didn't catch that,
  ambiguity "Alpha or Alpha Two?").
- `match(text, lang, lists, opts)` normalizes the text (case, punctuation,
  number words per language), strips the command word (the personal one
  from `opts.commandWord` when set), matches the templates and resolves
  each slot by the spoken-name score (defaults above), above a floor and
  with a margin over the runner-up. It returns a command, an ambiguity (2–3
  candidates), or nothing.
- `matchesPhrase(utterance, phrase)`: the normalized exact match for the
  personal phrases (decision 5). `weakPhrase(phrase, lang)`: the
  common-word rule (defaults above).
- `shared/voice.ts` `matchOption` gains an optional `labels` argument: the
  whole utterance equal to a row's label (normalized) picks it ("an
  option's words"). Number picks stay as they are.
- `src/lib/i18n/index.ts` exports `loadDict(lang)` (the private
  `ensureDict` as a promise), so the speech language's templates are there
  even when the UI is in another language.
- It must not import Zustand, Tauri or React, because the phone imports it.
- Tests in `src/__tests__/terminal/VoiceCommands.test.ts`, per language:
  templates, number words, close names ("Alpha" vs "Alpha Two", "alfa"),
  dictation that merely contains command words, the personal command word,
  `matchesPhrase` being exact, `weakPhrase`.

**S2 — `shared/voiceReading.ts`**: the outline, cursor, brief mode, summary
lookup and never-read rules, built on `spokenText` / `speechChunks` in
`shared/voice.ts`. Labels come in as callbacks. Tests in
`src/__tests__/terminal/VoiceReading.test.ts`: outline shapes (headings,
lists, code, tables), cursor moves (next, back, back twice, next answer at
the end), brief mode, summary found and not found.

### 2. App-level hands-free session (phone)

**2a — session core (S3).**

- `mobile-web/src/handsFreeSession.ts`: the session store (a tiny
  subscribe/get module like `speechOutput.ts`, no Zustand) and the state
  machine (Idle, Engaged, Dictating, Reading, Confirming), pure with an
  injected clock like `shared/handsFree.ts`.
  - Routing: command word at the start → Command; in the follow-up window
    → Command without the word; Dictating → the Focus consumer, unless the
    command word starts the utterance; Confirming → yes / no / the confirm
    phrase, 5 s.
  - Results are dropped while `speechOutput` speaks plus a 300 ms tail.
  - `SpeechEngine` interface and `WebSpeechEngine`, which wraps
    `voiceSession.ts` `startDictation`.
  - Exposes `armed`, `lastUtteranceAt` and `holdsIdleLock` for the App's
    lock effect, and `registerTerminal(handle)` for the Focus screen.
- `voiceSession.ts` gains a hands-free option:
  - no 120 s idle end (`IDLE_LIMIT_MS`) while armed;
  - restart after TTS, or keep running through it, per the step 0 result;
  - `holdScreenAwake` exported, so the session holds the wake lock for its
    whole life instead of per dictation.
- `src/lib/voice/chime.ts`: `playChime(kind)` with the earcons listening,
  heard, not understood, send-guard chime (today's sound, the default),
  link lost. The desktop's callers keep the default.
- New prefs keys, all in this step (S3 owns `prefs.ts` for the plan):
  `MobileFlag` `handsFreeCommands`, `voiceDriving`, `voiceBrief`,
  `voiceGapsPerChunk`; `MobileChoice` `voiceCommandWord`,
  `voiceConfirmPhrase`, `voiceRate`.
- Tests in `src/__tests__/mobile/MobileHandsFreeSession.test.ts` with a fake
  engine and clock: follow-up window open and close, command word inside
  dictation, results dropped during speech and the tail, the confirm
  timeout, the confirm phrase refusing "yes", disarm on page hidden.

**2b — App shell (S4).**

- Mounted at `App.tsx` level, so it survives tab and screen changes.
- The arm button in the App shell (next to the section tab bar, shown only
  with `handsFreeCommands` on) and `components/HandsFreePill.tsx`: on/off,
  the driving toggle, and the state as a big caption. The pill is the large
  tap fallback. Portaled UI sets an explicit `color`.
- The idle lock (decision 4, defaults above): the lock effect in `App.tsx`
  (lines 523–587) reads the session's hold and its 30-min limit.
- `mobile-web/src/mediaSession.ts`: the silent loop (the source the probe
  picked), `navigator.mediaSession` metadata and the button mapping, started
  in the arming tap, stopped on disarm.
- The App navigator the dispatcher will use (`goTo`, section switch, open
  tab), exposed through the session, so S7 does not edit `App.tsx` again.
- Untested rows `mobile.voice.session`, `mobile.voice.idleHold`,
  `mobile.voice.mediaButtons`. i18n keys for every string.

**2c — the Focus screen joins the session (S5, with step 4).**

- `useVoiceInput.ts`: while armed it does not call `startDictation`; it
  registers as the session's Dictating consumer and gets settled and
  interim results through the same `onResult` path it has today, so the
  send guard, `spokenSend` and the preview are unchanged.
- `useHandsFree.ts`: the turn wait (`handsFreeTurnOver`) tells the session
  when the turn is over instead of calling `startVoice`; the question
  read-out stays.
- `Terminal.tsx`: the Focus menu's Hands-free row arms the App session when
  `handsFreeCommands` is on, and keeps today's loop when it is off. It
  registers the `TerminalVoiceHandle` (dictation sink, question pick, model
  picker, interrupt, undo clear) while mounted.
- `useReadAloud` (`useSessionChat.ts`) reads at the end of the turn, not
  per entry, while armed, through S6's cursor. (S5 runs after S6.)

### 3. Read-aloud navigation (S6)

- `speechOutput.ts` moves to the `voiceReading` cursor, with the exports
  kept (above). The read position per tab is kept in memory.
- The reading commands as functions (`readNext`, `readBack`, `repeat`,
  `rate`, `readAll`, `readCode`, `where`), so the session (S3/S5), the
  Media Session buttons (S4) and the listen gaps all call the same ones.
- Brief and full, the rate step (persisted as `voiceRate`), and an
  `onSectionEnd` hook the session uses for listen gaps.
- `components/MessageMenu.tsx`'s Read aloud keeps working on the cursor.
- S6 does not touch `Terminal.tsx` or the session; it depends only on S2.
- Tests extend `src/__tests__/mobile/MobileSpeechOutput.test.ts`.

### 4. Kitchen loop in the Focus chat (S5, with 2c)

- Dictation → pause or "go on" → send guard → the answer is read at the end
  of the turn → the mic dictates again; commands need the command word
  (answered question 1).
- Question cards by voice through `voicePick` (`mobile-web/src/handsFree.ts`)
  and `matchOption` with labels. They run only while the Terminal is
  mounted, so voice navigates to the tab first (the handle).
- A classifier in `mobile-web/src/handsFree.ts`: `questionKind(prompt, ask)`
  → plain, permission or diff; `broadOption(option)` for "always", "don't
  ask again", "for this session", "all edits" and their per-CLI wording.
  Unit-tested on captured Claude Code and Codex prompts.
- Permission prompts (decision 3): the full question and options are read
  out. The approving row is chosen only by "yes" / "ja", or only by the
  personal confirm phrase when one is set. Broad rows are never pickable.
  A "no" row needs no confirm.
- Plain questions while armed: the pick is read back and confirmed (the
  catalog's C). With `handsFreeCommands` off, today's direct pick stays.
- Untested rows `mobile.voice.permission`, `mobile.voice.focusSession`.
- Tests extend `src/__tests__/mobile/MobileTerminalHandsFree.test.tsx` and
  `MobileHandsFree.test.ts`.

### 5. Phone command dispatcher (S7), voice settings (S8), apps by voice (S9)

**S7 — `mobile-web/src/handsFreeDispatch.ts`:** command id → App navigator
and `api.ts` call, over existing routes only (catalog above).

- The risk table for every catalog id, both columns (Cook, Drive), lives
  here, so S9 and S10 only read it.
- Live lists for the matcher come from the projects, the catalog's `TabRow`
  rows, launch options and model rows (`getModelRows`). Names resolve on
  the phone, and only opaque ids leave it.
- Projects, tabs, what's waiting, next waiting / done, new tab, close and
  reopen, undo clear, status, show on the desktop, stop and stop agent.
  Tab creation reuses `Project.tsx`'s create path; if it is inline, it is
  lifted into `api.ts` as `createTab` and `Project.tsx` calls it.
- Landing lines, spoken lists with a pager, and spoken confirmation (the
  Confirming state). Confirming accepts the personal confirm phrase when
  one is set (decision 5).
- The model picker through the handle and `useModelPicker` with arrows and
  Enter, saying "becomes your default" first.
- A command that starts agent use answers "AI is off" when the desktop
  reports `ai_off`, and otherwise goes through the same route a tap does,
  so `ai_off_guard` still decides.
- `mobile-web/src/handsFreeApps.ts` with handlers for the mail, calendar,
  to-do and local-model ids that answer "not yet" until S9 fills them.
- Untested rows `mobile.voice.commands`, `mobile.voice.confirm`.
- Tests in `src/__tests__/mobile/MobileHandsFreeDispatch.test.ts` with a
  mocked `api.ts`.

**S8 — This device → Voice:** a Voice row in Home's This device sheet
(`screens/Home.tsx`) opening `components/VoiceSheet.tsx`:

- the `handsFreeCommands` switch;
- the personal command word and confirm phrase (decision 5), stored as
  above, shown masked once saved;
- the weak-phrase warning (`weakPhrase`);
- the test: "say it three times", through `startDictation` (not the
  session), counting `matchesPhrase` hits, showing hits only, never the
  heard text of a confirm phrase.
- Untested row `mobile.voice.phrases`.

**S9 — mail, calendar, to-do and local models by voice:** fills
`handsFreeApps.ts`. The screens call their routes inline today
(`Mail.tsx`, `Calendar.tsx`, `Todo.tsx`), so the calls the voice needs are
lifted into `api.ts` helpers and the screens switch to them (one-line
swaps). Reply bodies, to-do texts and event titles are dictated and read
back in full before the confirm. Untested row `mobile.voice.apps`.

### 6. Announcements of other tabs (S10)

- `mobile-web/src/handsFreeAnnounce.ts`: while armed, an `/activity` poll
  (`visiblePoll.ts`) and `/alerts` feed an announcement queue, deduplicated
  with `seenDone.ts`. A question or done event plays an earcon and says
  "‹agent› in ‹project› is asking". Announcements wait for a gap between
  utterances and are never spoken during dictation.
- "Answer it" / "open it" jumps to the tab, as "next waiting" does.

### 7. Driving mode (S10)

- The toggle on the pill, and the Drive column of the catalog and the Modes
  table, read from S7's risk table.
- Short output, the 3-option limit, and destructive commands refused with
  "That waits until you're parked". Permission and diff approvals answer
  "Look when you're parked" (decision 3).
- Reconnect handling as in Defaults: an earcon, "No connection", the draft
  kept and confirmed after reconnecting.
- Untested rows `mobile.voice.announce`, `mobile.voice.driving`.

### 8. Help and docs (S11)

- The help topic `docs/help/talking-to-an-agent.md` gains a "Hands-free on
  the phone" section (commands per language, the two modes, the screen-on
  limit, the car caveats); `docs/help/mobile.md` links to it. No new topic.
- `docs/context/voice.md`: the App-level session, the command word and
  follow-up window, the idle-lock hold.
- File-map rows for the new modules (`docs/filemap_frontend.md`).
- A `todo/group-s-agents.md` entry next to "Voice in the Chat", with 🖐️
  boxes and the per-platform ✅/❌ pairs, and a follow-up for the desktop
  adopting `voiceReading` and the broad-option filter.
- Delete the probe page (`voiceProbe.tsx`, its `main.tsx` gate) and, unless
  S4 uses it, `silence.wav` and its reviewed-binaries line.

### Later (each its own plan run)

9. **Desktop whisper engine (architecture B).**
   - `mobile_speech_plan.md`'s `POST /api/v1/speech` becomes a
     `DesktopWhisperEngine`: an AudioWorklet plus Silero VAD on the phone,
     with one utterance sent per request.
   - The desktop's `services::voice` uses an `AudioSource` for phone PCM
     and a phone owner, and primes whisper with the live names
     (in-process, so not in argv).
   - Needs a `threat_model.md` pass, a `services::command_class` row and
     the `mobile_control` rules (opaque ids, rate and size bounds). The
     one-listener rule then spans the desktop and the phone. Web Speech
     stays the fallback.
10. **Desktop steering routes.** New `DesktopRequest` variants to focus a
    tab or open mail, calendar or to-do on the desktop. These are commands
    the user starts on the phone, never an agent path.
11. **Android Auto messaging companion.** A tiny native Android app.
    - It posts agent question and done events as messaging-style
      notifications with Reply and Mark-as-read. The car reads them aloud,
      and the spoken reply goes through the existing phone API
      (`sendPrompt`, option pick).
    - It needs its own pairing and auth on `mobile_control`, a threat-model
      pass, and its own build and release path. Replies are transcribed by
      Google.
    - No navigation commands there.
12. **A wake-word model** as an opt-in (licence decision first), and
    **speaker barge-in** via Piper over Web Audio (desktop plan phase 2).
13. **A model-written summary** of long answers (desktop model, opt-in,
    off with ⏻).

## Verification

- Unit tests (files named in the steps):
  - the matcher per language;
  - the reading cursor;
  - the state machine with a fake `SpeechEngine` (follow-up window,
    confirm timeout, results dropped during speech, command word inside
    dictation);
  - the permission classifier and the broad-option filter;
  - the dispatcher with a mocked `api.ts`;
  - the idle-lock hold and its 30-min limit;
  - the personal confirm phrase: when it is set, "yes" is refused and only
    the exact phrase confirms.
- Gates: `scripts/gates.sh` (frontend: build, test, lint, brand-check).
  No backend changes in steps 0–8. A step that finds it needs a route
  stops and asks; that route then gets a `services::command_class` row, the
  `mobile_control` opaque-id rules and a `commandClasses.ts` regeneration.
- Phone changes reach the phone only through the binary: the frozen dev
  build after a commit, relaunched by the user.
- Live (the user, by these steps):
  - **Kitchen:** turn on This device → Voice → Hands-free commands, arm on
    the counter, then say "‹word› what's waiting", "next waiting",
    "option one", "tell Claude …" … "go on". Check that stop cancels the
    send. Let an answer be read, then say "next", "skip this answer",
    "repeat". Use the fan at full speed. Leave it 4 minutes silent: no
    lock. Pull down the notification shade and come back.
  - **Permission:** on a Claude permission prompt, say "two" on a broad
    row: refused. Set a confirm phrase, say "yes": "Say your confirm
    phrase".
  - **Car, mounted:** turn driving mode on and press the steering-wheel
    button. Say "what's waiting" and "read the last answer" (should give
    brief mode), and "close tab" (should be refused). Drive through a
    tunnel and check the earcon and that the draft is kept.

## Organisation (if run as plan + implement + review)

- **Shape:** disjoint modules once S1–S3 fix the interfaces. Step 0's
  probe page is built first; the user runs it while S1, S2 and S6 run.
- **Handoff file:** `docs/phone_voice_handoff.md`. Each implementer appends
  its section: what landed, interfaces it exposed, the hot-file additions
  (below), and what it left open.

### Agent steps

| Agent step | Plan sections | Files | Est. |
|---|---|---|---|
| S0 probe page | step 0 | `mobile-web/src/voiceProbe.tsx` (new), `mobile-web/src/main.tsx`, `mobile-web/public/silence.wav` (new) | 0.5–1 d |
| S1 matcher | step 1 (S1) | `src/lib/voice/voiceCommands.ts` (new), `shared/voice.ts`, `src/lib/i18n/index.ts`, i18n dictionaries, test | 1.5 d |
| S2 reading model | step 1 (S2) | `shared/voiceReading.ts` (new), test | 1 d |
| S3 session core | 2a | `mobile-web/src/handsFreeSession.ts` (new), `mobile-web/src/voiceSession.ts`, `src/lib/voice/chime.ts`, `mobile-web/src/prefs.ts`, test | 1.5 d |
| S4 App shell | 2b | `mobile-web/src/App.tsx`, `mobile-web/src/components/HandsFreePill.tsx` (new), `mobile-web/src/mediaSession.ts` (new) | 1.5 d |
| S5 Focus joins + kitchen loop | 2c, 4 | `mobile-web/src/screens/Terminal.tsx`, `screens/terminal/useVoiceInput.ts`, `screens/terminal/useHandsFree.ts`, `mobile-web/src/handsFree.ts`, `useSessionChat.ts` (`useReadAloud` only), tests | 1.5 d |
| S6 read-aloud cursor | 3 | `mobile-web/src/speechOutput.ts`, `screens/terminal/useSessionChat.ts`, `components/MessageMenu.tsx`, test | 1.5 d |
| S7 dispatcher | 5 (S7) | `mobile-web/src/handsFreeDispatch.ts` (new), `mobile-web/src/handsFreeApps.ts` (new, stubs), `api.ts` (`createTab` only), `screens/Project.tsx` (one call), test | 1.5 d |
| S8 voice settings | 5 (S8) | `mobile-web/src/components/VoiceSheet.tsx` (new), `mobile-web/src/screens/Home.tsx` | 1 d |
| S9 apps by voice | 5 (S9) | `mobile-web/src/handsFreeApps.ts`, `api.ts`, `screens/Mail.tsx` / `Calendar.tsx` / `Todo.tsx` (one-line swaps) | 1.5 d |
| S10 announcements + driving | 6, 7 | `mobile-web/src/handsFreeAnnounce.ts` (new), `handsFreeSession.ts` (drive policy), `components/HandsFreePill.tsx` (toggle) | 1.5 d |
| S11 docs + probe removal | 8 | help topics, `docs/context/voice.md`, filemap, todo, delete S0's files | 0.5 d |

### Dependency graph and batches

```
S0 ──▶ the user runs the probe ──▶ results
S1, results ──────────▶ S3
S2 ──▶ S6
S3, results(3) ───────▶ S4
S1, S3, S6 ───────────▶ S5
S1, S3 ───────────────▶ S8
S4, S5 ───────────────▶ S7
S7 ───────────────────▶ S9
S7, results(3, 4) ────▶ S10
everything ───────────▶ S11
```

- **Batch A** (no probe results needed), in parallel worktrees: S0 ∥ S1 ∥ S2.
- **Batch B:** S3 (once the results are in) ∥ S6 (needs only S2; may start
  as soon as S2 has landed, before the results).
- **Batch C:** S4 ∥ S5 ∥ S8. S5 needs S1, S3 and S6; S4 needs S3 and probe
  item 3; S8 needs S1 and S3's prefs keys. Their files are disjoint.
- **Batch D:** S7 alone (needs S4's navigator and S5's handle).
- **Batch E:** S9 ∥ S10 (S9 fills `handsFreeApps.ts`; S10 reads S7's risk
  table and edits the pill and the session; disjoint).
- **Batch F:** S11.
- At most 3 implementers at once. One reviewer per batch, checking against
  the fixed decisions and the invariants, and a final review across the
  whole diff. No step runs cargo.

### Hot shared files

Parallel implementers do not edit these on `develop`. They may add to them
in their worktree so their gates pass, list every addition in the handoff,
and the main agent applies the lists once per batch (discarding the
worktree hunks for these files):

- `src/lib/i18n/{en,de,es,fr,it}.ts` (every language needs every key);
- `src/lib/untested.ts` (the phone's pills use it too, `mobile.*` ids);
- `mobile-web/src/prefs.ts` (S3 adds all of this plan's keys; later steps
  only read them);
- `mobile-web/src/style.css` (S4, S5, S8 add rules);
- `mobile-web/src/api.ts` (S7, S9; sequential, but listed so S10 does not
  touch it);
- `docs/filemap_frontend.md`, `todo/group-s-agents.md`,
  `docs/context/voice.md`, `docs/help/*.md` (S11 only);
- `scripts/privacy-reviewed-binaries.txt` (S0 only).

A step that runs alone in its batch (S7, S11) edits these directly.

### Why

After S1–S3 the work is frontend-only and splits by module. The risk lies
in the phone's runtime behaviour, which reviewers cannot check, so the
probe results gate the session core (S3), the Media Session (S4) and
driving (S10), and the matcher and reading model are built meanwhile.

## Answered questions (the user's, 2026-10-28)

1. **Follow-up window after an agent's answer:** (a). The window opens after
   Tabtivity's own replies (landing lines, lists, "didn't catch that",
   announcements). After an agent's answer the mic dictates, and commands
   need the command word, except the whole-utterance reading commands and
   option picks.
2. **Page hidden while armed:** (a). The session disarms and the normal
   3-minute rule applies from the last touch or utterance.
3. **Default command word:** (a). `{app}`, the brand name, filled by the
   brand rule. Probe item 7 measures how well it is heard; if it fails, the
   user picks again.
4. **Probe gate:** S0, S1 and S2 run now (Batch A), and S6 may follow S2.
   The run then pauses until the user reports the step 0 results; S3 and
   everything after it wait for them.
