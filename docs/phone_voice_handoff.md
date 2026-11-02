# Phone hands-free voice — implementer handoff

Plan: `docs/phone_voice_plan.md`. Each agent step appends its section: what
landed, the interfaces it exposed, its hot-file additions, what it left open.

## S1 — the shared matcher (branch `voice-s1`)

**Commit:** `84fa7923` holds the code, tests and dictionaries. This
section is in the commit after it.

### What landed

- `src/lib/voice/voiceCommands.ts` (new): the command catalog, `match`, the
  command word, the spoken-name score, ambiguity and its answer, the reading
  commands, the confirm answer, the personal-phrase helpers and the spoken
  lines. Imports only `shared/voice`, `lib/fuzzy` and `translate` from
  `lib/i18n` (no Zustand/Tauri/React import of its own; see gotchas).
- `src/lib/i18n/index.ts`: `loadDict(lang)`. `ensureDict` now returns its
  promise (shared by concurrent callers, cleared on failure so a retry works).
- `shared/voice.ts`: `matchOption(utterance, count, labels?)`. A whole
  utterance equal to one row's label (normalized) picks it. Number picks
  are unchanged and checked first. Two equal labels pick neither.
- 71 keys in each of the five dictionaries (listed below).
- `src/__tests__/terminal/VoiceCommands.test.ts` (new, 53 tests).

### Public interface

```ts
// catalog
export const VOICE_COMMANDS: { [id]: { slots?: VoiceSlot[]; optional?: VoiceSlot[] } };
export type VoiceCommandId = keyof typeof VOICE_COMMANDS;   // 53 ids, below
export const VOICE_COMMAND_IDS: VoiceCommandId[];
export const VOICE_READ_IDS: readonly ["next","nextAnswer","back","repeat","faster",
  "slower","summary","readAll","readCode","where","stop"];
export type VoiceReadId;
export type VoiceSlot = "project"|"box"|"tab"|"agent"|"model"|"effort"|"card"|"localModel"|"n"|"text";
export type VoiceNameSlot = Exclude<VoiceSlot, "n"|"text">;

// inputs
export interface VoiceListItem { id: string; name: string; aliases?: readonly string[] }
export interface VoiceLists { projects?; boxes?; tabs?; agents?; models?; efforts?; cards?; localModels? }  // readonly VoiceListItem[]
export interface VoiceMatchOptions { commandWord?: string | null; requireCommandWord?: boolean /* default true */ }

// result
export type VoiceArgs<Id>;   // typed per id: openProject → { project }, newAgentTab → { agent; project? }
export type VoiceCommand = { kind: "command"; id: Id; args: VoiceArgs<Id>; heardCommandWord: boolean } /* union over ids */;
export interface VoiceAmbiguity { kind: "ambiguous"; id; slot: VoiceNameSlot; candidates: VoiceListItem[] /* 2–3, best first */;
  partial: Partial<Record<VoiceSlot, VoiceListItem|number|string>>; heardCommandWord: boolean }
export interface VoiceNothing { kind: "nothing"; reason: "noCommandWord"|"commandWordOnly"|"unknownName"|"unmatched"; heardCommandWord: boolean }
export type VoiceMatch = VoiceCommand | VoiceAmbiguity | VoiceNothing;

// functions
match(text: string, lang: Language, lists?: VoiceLists, opts?: VoiceMatchOptions): VoiceMatch
resolveAmbiguity(answer: string, ambiguity: VoiceAmbiguity, lang: Language): VoiceCommand | null
hasCommandWord(utterance: string, lang: Language, commandWord?: string | null): boolean
defaultCommandWord(lang: Language): string
matchReading(utterance: string, lang: Language, commandWord?: string | null): VoiceReadId | null
matchesPhrase(utterance: string, phrase: string | null | undefined): boolean
matchConfirm(utterance: string, lang: Language, confirmPhrase?: string | null): "yes"|"no"|"needPhrase"|"other"
weakPhrase(phrase: string, lang: Language): boolean
didNotCatchLine(lang: Language): string
ambiguityLine(lang: Language, candidates: readonly VoiceListItem[]): string   // "Alpha or Alpha Two?"
export const BUILTIN_AGENT_ALIASES: Record<string, readonly string[]>;        // claude: ["cloud", …]
export const NAME_FLOOR = 0.65, NAME_MARGIN = 0.15;

// lib/i18n
loadDict(lang: Language): Promise<boolean>   // true once translate(lang, …) answers in lang; never rejects

// shared/voice
matchOption(utterance: string, count: number, labels?: readonly string[]): number | null
```

Narrow on `id` to read typed args:
`if (m.kind === "command" && m.id === "openProject") api.openProject(m.args.project.id)`.

**Command ids** (each `voice.cmd.<id>`): projects, root, openProject{project},
openBox{box}, showOnDesktop{project}, whatsWaiting, whatsWorking,
nextWaiting, nextWorking, nextDone, status, tabNumber{n},
agentTab{agent, n?}, goToTab{tab}, nextTab, previousTab,
newAgentTab{agent, project?}, newShell{project?}, newMonitor, closeTab,
reopenTab, listNext, listBack, listPick, tell{agent, text}, dictate, stop,
stopAgent, model{model}, effort{effort}, plan, goal, clearConversation,
undoClear, openMail, nextMail, readMail, flagMail, markRead,
replyMail{text}, openCalendar, today, nextEvent, newEvent{text}, openTodo,
newTodo{text}, doneTodo{card}, closeApp, loadModel{localModel},
unloadModel{localModel}, files, sidePanel, settings. This covers the
phone catalog and the navigation plan's command set. A dispatcher skips the
ids it does not serve. Risk levels are not here: they belong to S7's risk
table.

### i18n keys added (en, de, es, fr, it, all 71 in each)

- `voice.commandWord` = `{app}` in every language, filled by `fillBrand`.
- `voice.cmd.<id>` for the 53 ids above: `|`-separated templates with
  `{slot}`s.
- `voice.read.<id>` for the 11 `VOICE_READ_IDS`.
- `voice.confirmYes`, `voice.confirmNo`.
- `voice.say.didNotCatch`, `voice.say.ambiguous2` (`{first}`, `{second}`),
  `voice.say.ambiguous3` (`{first}`, `{second}`, `{third}`),
  `voice.say.confirmPhrase`.

They are appended at the end of each dictionary.

### Choices and gotchas

- **Speech language.** `match(…, lang)` reads `translate(lang, …)`. Until
  that language's chunk is loaded, the English templates stand in, so the
  phone should `await loadDict(speechLang)` when it arms. The module imports
  `translate` from `lib/i18n`, which itself uses Zustand and React. The
  phone already imports `lib/i18n` in several modules (`connection.ts`,
  `localLock.ts`, `projectOrder.ts`, …), so this adds no dependency. If a
  reviewer wants the matcher free of that transitive import as well, the
  next step is to inject a `(lang, key) => string` lookup.
- **Normalization:**
  - case and accents are folded (`ß` becomes `ss`);
  - apostrophes and hyphens split words ("what's" → "what s", "l'onglet",
    "to-do");
  - number words become digits per language: cardinals 1–20 (French 1–16
    and 20) and ordinals 1–10 with their forms, and "2nd", "2e", "2a"
    become "2";
  - articles that double as "one" are left out (de "ein", es "una",
    it "un"/"una"). French "un" is kept, because templates are normalized
    the same way;
  - polite words ("please", "bitte", "por favor", "s'il te plaît",
    "per favore") are dropped at either end.
- **Whole-utterance templates.** A template must cover the whole utterance.
  If several fit, the one with more literal words wins ("new monitor" beats
  "new {agent}"), then the better name score, then catalog order. `{n}` is
  one number from 1 to 99. `{text}` is always last and returns the raw
  heard text: punctuation inside it and right after it is kept, trailing
  commas are dropped.
- **Name score.** The edit distance on a light phonetic key (ph→f, th→t,
  ck→k, c before a/o/u → k, qu→k, y→i, double letters collapsed) is the
  best of three measures: per word (equal word counts), over the joined
  letters, or as a word prefix of a longer name (0.6 + 0.2 × the share of
  the name covered). `fuzzyMatch` only orders equal scores. A name must
  reach the floor of 0.65 and lead the runner-up by 0.15; otherwise the
  matcher asks back with the top 2–3. Results:
  - "alpha" → Alpha, with "Alpha 2" also in the list;
  - "alfa" → Alpha;
  - "alpha" with only "Alpha Two" and "Alpha Three" → ambiguous;
  - "delta" for Beta is below the floor;
  - **"zeta" for Beta passes**: one letter off a four-letter name.
- **Command word.** It is an exact, normalized match of the first 1–4 words,
  joined, so "Tab tivity" also counts. A personal word replaces the default,
  which then no longer works. A blank personal word means the default. The
  same rule applies to the default word (no fuzzy margin).
- **`requireCommandWord`** defaults to `true`. Pass `false` for the
  follow-up window or for push-to-talk. `heardCommandWord` is always
  reported:
  - `noCommandWord` means the utterance is dictation;
  - `unmatched` or `unknownName` with `heardCommandWord` means
    "Didn't catch that";
  - `commandWordOnly` is the word said alone. Whether that opens a listening
    turn is S3's choice.
- **`matchesPhrase`** ignores case, accents, spaces and punctuation. Nothing
  else is fuzzy, and number words are not mapped, because the function has
  no language.
- **`matchConfirm`.** With a phrase set, a plain yes gives `needPhrase`.
  Every result other than `yes` cancels.
- **`weakPhrase`** applies the plan's rule exactly: a single word under 6
  letters, or any word that is a catalog literal (commands, reading
  commands, yes or no) or a number.
- **`resolveAmbiguity`** tries the name first, so "Alpha Two" is read as a
  name and not as "two". After that it tries `matchOption` (English and
  German phrases such as "the second one"), then a bare number of at most
  two words ("la seconda").
- **Bare `{agent}` template.** "Claude" said alone is `agentTab`. Because
  this template has no literal words of its own, it never turns a failure
  into `unknownName`.

### Gates

`scripts/gates.sh` on the change:

| Gate | Result |
|---|---|
| brand-check | PASS |
| `git diff --check` | PASS |
| `npm run lint` | PASS |
| `npm run build` (tsc + bundles) | PASS |
| vitest `--changed` | green after reruns (see below) |

The `vitest --changed` gate covers the whole suite, because every component
imports the dictionaries.

1. **First run:** 650 files, 5852 tests, 46 failed. The machine was at load
   about 88 on 24 cores, with other implementers running. All 46 failures
   were 20 s timeouts or forks workers that failed to start.
2. **Rerun of the 106 affected files** (`--maxWorkers=4`): 1159 tests, 1158
   passed. The one failure was `PdfZoomRaster`'s timing test.
3. **That file alone:** 5/5 passed.

The new `VoiceCommands.test.ts` has 53 tests, all passing; `VoiceText` and
`i18n` pass too. `scripts/privacy-check.sh` passes on the staged change.
No Rust change.

### Flagged for user

- **Default command word.** It is `{app}` (answered question 3), not yet
  measured. Probe items 5 and 7 decide whether it stays.
- **Phrases.** The es, fr and it phrases are mine and were not reviewed by a
  native speaker. The French phrases use the tu form for commands (plus
  infinitives), and the spoken lines use vous, to match the UI.
- **Short names.** Names one letter apart on a short name match ("zeta" →
  Beta). Raising `NAME_FLOOR` to about 0.8 would refuse this, but would also
  refuse misheard names such as "bita".
- **Hot files.** No filemap row was added for `voiceCommands.ts`; the
  filemap belongs to S11. The dictionaries were edited directly, as
  briefed.
- **Not run live.** Matcher only: no UI, no pill.

## S2: reading model (`shared/voiceReading.ts`)

**Commit:** `b92c3d98` (code and tests; this section is the commit after it) on `voice-s2`.

### What landed

- `shared/voiceReading.ts` (new, pure: no browser, no i18n, no clock).
  - The outline: sections at `#` headings and at whole-line bold
    ("**Summary**"), then paragraphs and list items, then chunks of at most
    220 characters.
  - The never-read rules, each with a spoken placeholder: code blocks (also
    those inside list items), tables, a long list's tail (more than 5 items:
    the first 3, then "and N more"), paths (file name only, `:42` line refs
    dropped), URLs ("a link"; a markdown link reads its label).
  - Views: `full`, `all` (also list tails and table rows), `brief`, `outline`,
    `summary`.
  - The cursor (answer → section → chunk), with every reading command from
    the plan's table except rate and stop (S6 owns those).
  - `DRIVING_LIMITS` / `KITCHEN_LIMITS` for the Modes table.
- `shared/voice.ts`: `speechChunks` now ends a sentence only at `.!?…`
  followed by a space or the end, so `chime.ts`, `v0.2.47` and `3.5` no longer
  split into "chime. ts". The phone's and the desktop's current read-aloud get
  this too. The regex is exported as `SENTENCE`. This is a separate hunk from
  S1's `matchOption` change, so the two should merge cleanly.
- Tests: `src/__tests__/terminal/VoiceReading.test.ts` (27), plus one case
  in `VoiceText.test.ts`.

### Public interface (for S6)

```ts
export const MAX_SPEECH_CHUNK = 220;
export const READING_LABEL_KEYS: readonly ReadingLabelKey[];       // the 11 keys below
export type ReadingTranslate = (key: ReadingLabelKey, params?: Record<string, string | number>) => string;
export function readingLabels(t: ReadingTranslate): ReadingLabels; // picks the …One keys
export interface ReadingLabels { code(n); table(n); more(n); link(); answered(agent, n); answeredLong(agent, n); where(p: ReadingPosition) }

export interface ReadingLimits { maxSentences: number; maxChars: number; announceLong: boolean }
export const KITCHEN_LIMITS, DRIVING_LIMITS: ReadingLimits;
export type ReadingMode = "full" | "brief";
export type ReadingView = "full" | "all" | "brief" | "outline" | "summary";
export interface ReadingOptions { labels; mode?: ReadingMode; limits?: ReadingLimits; maxChunk?; listHead?; longList? }

export interface ReadingChunk { text: string; kind: "intro" | "heading" | "text" | "item" | "code" | "table" | "more" | "source"; code?: number }
export interface ReadingPosition { id; answer; answers; section; sections; chunk; chunks }   // 1-based
export interface ReadingAnswer { id: string; text: string; agent: string }

export function outlineAnswer(markdown, view: ReadingView, options, agent = ""): ReadingOutline;
export function codeChunks(code: string, maxChunk?): ReadingChunk[];
export function createReadingCursor(options: ReadingOptions, answers?: readonly ReadingAnswer[]): ReadingCursor;

interface ReadingCursor {
  setAnswers(answers): void;          // follows the position by id; a grown answer keeps it
  setOptions(options): void;          // brief/full, driving limits; per-answer summary/read-all stay
  start(id, { follow? }): ReadingChunk | null;
  current(): ReadingChunk | null;     // being said / just said; null before start or after end
  advance(): ReadingChunk | null;     // call when the current chunk's utterance ended
  atSectionEnd(): boolean;            // a listen gap goes after this chunk
  ended(): boolean;
  next(); nextAnswer(); back(); repeat(); summary(); readAll(); readCode(): ReadingChunk | null;
  position(): ReadingPosition | null;
  where(): string | null;             // the spoken "answer 2 of 3, section 2 of 4"
}
```

How S6 drives it: keep one cursor per tab in module state (that is the
in-memory read position). Feed it `transcriptTurns(...).filter(answer)` as
`{ id: turn.key, text: turn.text, agent }` on every transcript change. For a
fresh answer call `start(key, { follow: true })`; for MessageMenu's Read
aloud on one message call `start(key)`. Speak `current()`. On `onend`: when
`atSectionEnd()`, run `onSectionEnd` (listen gap) first, then `advance()`.
`null` means stop. On every command, bump `generation`, cancel speech, and
speak the chunk the move returned (`null` = stop). After the end, with
`follow`, a later `advance()` picks up answers that arrived since.
`currentSpeechId()` can stay the answer id (`position().id`).

### i18n keys needed (main agent adds them; S2 did not touch the dictionaries)

Speech language, filled with `translate(lang, key, params)`. The quoted word
in `answeredLong` must be the language's `voice.read.summary` command (S1).

| key | en | de |
|---|---|---|
| `voice.reading.code` | code block, {n} lines | Codeblock, {n} Zeilen |
| `voice.reading.codeOne` | code block, one line | Codeblock, eine Zeile |
| `voice.reading.table` | a table, {n} rows | eine Tabelle, {n} Zeilen |
| `voice.reading.tableOne` | a table, one row | eine Tabelle, eine Zeile |
| `voice.reading.more` | and {n} more | und {n} weitere |
| `voice.reading.link` | a link | ein Link |
| `voice.reading.answered` | {agent} answered, about {n} lines | {agent} hat geantwortet, etwa {n} Zeilen |
| `voice.reading.answeredOne` | {agent} answered, one line | {agent} hat geantwortet, eine Zeile |
| `voice.reading.answeredLong` | {agent} answered, about {n} lines. Say “summary”, or listen later. | {agent} hat geantwortet, etwa {n} Zeilen. Sag „Zusammenfassung“ oder hör später rein. |
| `voice.reading.answeredLongOne` | {agent} answered, one long line. Say “summary”, or listen later. | {agent} hat geantwortet, eine lange Zeile. Sag „Zusammenfassung“ oder hör später rein. |
| `voice.reading.where` | answer {answer} of {answers}, section {section} of {sections} | Antwort {answer} von {answers}, Abschnitt {section} von {sections} |

Suggested es / fr / it, in the same order:

- es: `bloque de código, {n} líneas` · `bloque de código, una línea` ·
  `una tabla, {n} filas` · `una tabla, una fila` · `y {n} más` · `un enlace` ·
  `{agent} respondió, unas {n} líneas` · `{agent} respondió, una línea` ·
  `{agent} respondió, unas {n} líneas. Di «resumen» o escucha más tarde.` ·
  `{agent} respondió, una línea larga. Di «resumen» o escucha más tarde.` ·
  `respuesta {answer} de {answers}, sección {section} de {sections}`
- fr: `bloc de code, {n} lignes` · `bloc de code, une ligne` ·
  `un tableau, {n} lignes` · `un tableau, une ligne` · `et {n} de plus` ·
  `un lien` · `{agent} a répondu, environ {n} lignes` ·
  `{agent} a répondu, une ligne` ·
  `{agent} a répondu, environ {n} lignes. Dites « résumé » ou écoutez plus tard.` ·
  `{agent} a répondu, une longue ligne. Dites « résumé » ou écoutez plus tard.` ·
  `réponse {answer} sur {answers}, section {section} sur {sections}`
- it: `blocco di codice, {n} righe` · `blocco di codice, una riga` ·
  `una tabella, {n} righe` · `una tabella, una riga` · `e altri {n}` ·
  `un link` · `{agent} ha risposto, circa {n} righe` ·
  `{agent} ha risposto, una riga` ·
  `{agent} ha risposto, circa {n} righe. Di' «riepilogo» o ascolta più tardi.` ·
  `{agent} ha risposto, una riga lunga. Di' «riepilogo» o ascolta più tardi.` ·
  `risposta {answer} di {answers}, sezione {section} di {sections}`

`ReadingLabelKey` is a union of these literals. Once they are in `en.ts`,
`(key, params) => translate(lang, key, params)` passes as a
`ReadingTranslate` with no cast. If a key is missing, S6's call site fails
to type-check.

### Choices and gotchas

- **Back twice:** the first "back" goes to the previous chunk. A second one,
  before any `advance` or other move, goes to the start of the section
  *before* the one the cursor was in, and each further "back" goes one more
  section back. It crosses into the previous answer. "Before the cursor moved
  on" is the pure stand-in for "twice": no clock.
- **"next"** at an answer's last section goes on to the next answer. With
  `follow` off, `advance` stops at the answer's end. Explicit moves always
  cross answers.
- **Short answers in brief:** an answer counts as short, and is read whole,
  when it has ≤ `maxSentences` sentences **or** ≤ `maxChars` characters (the
  plan's "≤ ~2 sentences or ~15 s", read literally). Brief items are the
  heading plus the first sentence, cut to `maxChars`.
- **Driving** = `{ mode: "brief", limits: DRIVING_LIMITS }`. A long answer
  becomes the single `answeredLong` line. "summary" then gives its summary
  section, or the outline.
- **"summary"** reads the last section titled summary / in short / TL;DR /
  Zusammenfassung / Fazit / résumé / riepilogo… (a built-in list for all
  five languages, matched on the heading or on a lead such as
  "**TL;DR:** …"). Without one it reads the outline (headings and first
  sentences, no intro line).
- **"read all"** re-renders from the section the cursor is in. It does not
  read code; "read the code" does that, as a detour. `advance` then goes on
  after the placeholder.
- **"about N lines"** counts non-blank source lines, exact up to 10, then to
  the nearest 10.
- A path is a token that starts with `/`, `~/`, `./`, `../` or `C:\`, or a
  relative one whose last part has an extension, ends in `/`, or has 3 or
  more parts with letters. So "and/or", "1/2", "km/h" and dates stay text,
  but "read/write/execute" is read as "execute".
- A whole-line bold line counts as a heading, so a bold line on its own
  ("**Done.**") starts a section.
- `tsc` targets ES2020, so the code uses no `.at()` and no `replaceAll`.

### Gates

`scripts/gates.sh` (frontend selection):
- brand-check: PASS.
- `git diff --check`: PASS.
- `npm run lint`: PASS, no new warnings.
- `npm run build`: PASS (tsc, desktop, mobile and web bundles).
- vitest `--changed`: 129 files, 1106 tests, 1088 passed on the first run.
  The 18 failures in 12 unrelated mobile and desktop UI files were 20 s
  timeouts at a load average of 86 (S0 and S1 were running gates at the
  same time). Re-run alone with `--maxWorkers=3`, all 12 files pass:
  49/49.
- `VoiceReading.test.ts`: 27/27. `VoiceText.test.ts`: 13/13, one new case.
- `scripts/privacy-check.sh`: PASS.
- No Rust was changed, so no cargo gate ran.
- The post-commit hook says "mobile bundle is stale". `shared/voice.ts`
  feeds the phone bundle, so `npm run mobile:bundle` is due when this lands.
- Not run live.

### Flagged for user

- Whether "back, back" should go to the section before (as built) or restart
  the current one first, like a music player's "previous".
- Whether the `answeredLong` wording ("Say “summary”, or listen later") is
  right. The plan wrote "say summary or later".
- Whether a long list should be cut after 3 of more than 5 items (as built)
  or at another count.

## S0: probe page (branch `voice-s0`, `.claude/worktrees/voice-s0`)

Commit `4875b6eb` on `voice-s0` (from develop 70344a96), not pushed, never run
on a phone.

What landed:
- `mobile-web/src/voiceProbe.tsx` (new, its own lazy chunk): one page, one
  card per probe item, one probe running at a time. Each card has a Start
  button (the gesture), and a running probe can add its own buttons (Turn,
  Speak 5 s, Open mic 6 s). The sticky bar has **Mark ◆**, which puts a ◆ in
  the running probe's log (for "I heard a beep", "the music muted"), plus
  **Stop** and **Copy results**. Every recognizer event (`start`,
  `audiostart`, `soundstart`, `speechstart`, `speechend`, `final` with the
  alternatives, `error`, `end`), every TTS start and end, and every media
  button gets a log line with its time since Start. Each probe also keeps
  summary notes: gap stats (n/min/median/max), counts and verdicts.
  - 1a: speaks, then restarts a single-shot recognizer by code after each
    reply, no tap, for 1/2/5/10 min. Measures the gaps from TTS end to
    `start` and to `audiostart`, and from `end` to `start` when nothing was
    heard. Stops with a verdict on `not-allowed`, or when the recognizer
    keeps ending at once.
  - 1b: one continuous recognizer runs while the phone speaks a sentence
    every 15 s. Counts its ends (and how many fell while speaking), the
    restart gaps, the unbroken session lengths, and the finals or interims
    that arrived during speech (logged as DROPPED).
  - 2: the phone says a known sentence three times while listening.
    Reports the share of its words that came back, once with the plain
    recognizer and once with `start(track)` on the echo-cancelled track
    from `openMicMeter` (it logs the track's actual `echoCancellation`, and
    the mic peak level while speaking and while quiet).
  - 3: a silent looping `<audio>` with four sources: `webaudio`
    (MediaStreamDestination as `srcObject`, with an optional faint 40 Hz
    tone), `file` (`/silence.wav`; logs the served status and
    content-type), and `data` / `blob`, which are expected to be blocked.
    It sets Media Session metadata and handlers for play, pause, stop,
    next/previous track, seek backward/forward, seekto, togglemicrophone
    and hangup, and logs which handlers were refused. Every press is
    logged with the state at that moment (playing, speaking, mic open).
  - 4: lists the `getUserMedia` default input and every input and output
    label, and re-lists them on `devicechange`. Each **Turn** times the
    prompt, TTS end → `audiostart`, `speechend` → final, and the whole turn.
  - 5: continuous listening for a set time with nobody talking. Every final
    that matches a candidate word is logged as a FALSE TRIGGER.
  - 6: no wake lock. Mode `mic` (getUserMedia plus level samples) or mode
    `recognizer`. Logs visibility, `freeze`/`resume`/`pagehide`/`pageshow`
    and track `ended`/`mute`/`unmute`. When the page comes back it reports
    what survived, and then tries a restart without a tap.
  - 7: the candidates are `BRAND.display` (never spelled) plus a
    comma-separated field. You pick the word, 1 m / 3 m and fan off/on, and
    each final is sorted as one of: `token` (the candidate's words
    appear exactly), `split` (2–3 adjacent words that join into it, e.g.
    "tab tivity"), `alt` (only in a lower-ranked alternative,
    `maxAlternatives` 3) or `miss`. Every utterance plays the chime. The
    cells add up across runs, and the card shows them as a table.
  - Setup card: language (default `speechTag()`), an on-device switch, and
    **Check on-device** (`prepareOnDeviceSpeech`; it turns the switch on
    when the result is `local` or `installed`).
- `mobile-web/src/main.tsx`: renders `<VoiceProbe/>` (behind `React.lazy` +
  `Suspense`) instead of `<App/>` only when the URL has `?voiceProbe`
  and `localStorage[storageDashKey("show-untested-tags")] === "true"`. That
  is the key App.tsx writes from `getMobileStatus().show_untested_tags`.
  Otherwise the app renders as before, and the probe chunk is never fetched.
- `mobile-web/public/silence.wav` (new, 48 044 B): 8-bit mono 8 kHz PCM,
  6 s at the zero line. Its blob id `963fe49c…` is in
  `scripts/privacy-reviewed-binaries.txt` (hot file, S0 only).
- `mobile-web/src/voiceSession.ts`: `holdScreenAwake`, `openMicMeter` and
  `MicMeter` are now exported, so the probe reuses them. Nothing else
  changed there. S3 may keep these exports or fold them back.
- Reused: `speak`/`subscribeSpeech`/`currentSpeechId`/`stopSpeaking`/
  `unlockSpeech` (speechOutput), `speechRecognitionConstructor`/
  `prepareOnDeviceSpeech` (voiceInput), `speechTag` (speechLang),
  `playChime`.
- No i18n keys, no untested row, no CSS (inline styles in fixed dark
  colours), as the plan records for this dev tool. S11 deletes
  `voiceProbe.tsx`, the gate in `main.tsx` and `silence.wav` together
  with its reviewed-binaries line.

How the user opens it on the phone:
1. Relaunch the frozen dev build that contains this commit (the phone
   bundle is baked into the binary; this commit queues the build).
2. On the desktop: Settings → General → **Show untested tags** on.
3. On the phone, open the Tabtivity app once, signed in, and leave it in
   front for a few seconds. The status probe caches the flag right away
   and again every 30 s.
4. In **Chrome** on the phone (the installed app has no address bar), open
   the same address the phone app uses, with `/?voiceProbe` added, e.g.
   `https://<your phone address>/?voiceProbe`. Chrome shares the installed
   app's storage. If the plain app opens instead, the flag is not cached in
   that browser: sign in there once (step 3), then reload.
5. Run the probes. In the kitchen: Setup → Check on-device, then 1a, 1b, 2,
   3 (webaudio, then file), 5 with the fan on, 6 (both modes), and 7 (the
   app's name at 1 m and 3 m, fan off and on, 10 times each). In the car,
   on Bluetooth: 3 (webaudio and file, the steering-wheel buttons before
   and after Open mic) and 4 (several Turns). Then **Copy results** and
   paste the text back.

What Copy results gives (shape; the real lines vary):
```
VOICE PROBE 0.2.47 · ab12cd 2026-10-29T08:12:03.000Z
ua: Mozilla/5.0 (Linux; Android 15; …) Chrome/141…
lang=de-DE on-device=on (check: local (40 ms)) · browser tab · secure=true
SpeechRecognition=yes speechSynthesis=yes (31 voices) mediaSession=yes wakeLock=yes AudioContext=yes

[p1a] 1a · Restart after speaking, no tap · runs 1
  cycles: 37
  tts end → rec start: n=18 min=180 med=260 max=900 ms
  tts end → audiostart: n=18 min=420 med=510 max=1300 ms
  rec end → rec start (nothing heard): n=19 min=40 med=60 max=120 ms
  errors: none
  verdict: kept restarting for 5 min, 37 cycles
  log (last 25, 212 earlier not copied):
    +298.10s rec:start
    +298.62s rec:audiostart
    …
[p7] 7 · Command word · runs 4
  <app name> · 1 m · fan off: 8/10 token, 1 split, 0 alt-only, 1 miss · heard "tab tivity"×1 "activity"×1
```
Every probe that ran gets a block: its notes in full, plus the last 25 log
lines. The text also appears in a box under the bar, for copying by hand
when the clipboard refuses.

Gotchas:
- **`silence.wav` is served as `application/octet-stream`.** The
  `build.rs` mime table (`generate_mobile_assets`) has no `wav` row, and
  the phone sends `nosniff`. Chrome's media stack normally sniffs the
  container anyway, but that is untested. Probe 3 `file` logs the served
  content-type and any `audio:error`. If it fails there, the fix is a
  `"wav" => "audio/wav"` row (a backend change: needs a cargo gate and a
  dev build). S0 did not touch it, since the plan says no step runs cargo.
- **The file is 6 s (48 KB), not "a few hundred bytes".** As far as I know,
  Chrome on Android shows no media notification and claims no media focus
  for a player shorter than about 5 s, so a short file would fail probe 3
  for the wrong reason. A `srcObject` stream has no duration and is not
  affected.
- CSP (checked in `host.rs`, non-desktop branch): `default-src 'self'`
  with no `media-src`. `data:`/`blob:` media are blocked: probe 3 listens for
  `securitypolicyviolation` and logs `CSP BLOCKED: media-src refused …`.
  The `'self'` file and `srcObject` need nothing from the CSP. The HEAD
  `fetch` is allowed by `connect-src 'self'`. Permissions-Policy already
  allows `microphone` and `on-device-speech-recognition` for self.
- The page bypasses `App` entirely: no pairing, no local lock, no API.
  Anyone who has both the cached flag and the URL sees a page that only
  talks to the phone's own browser.
- The service worker passes `/silence.wav` and the probe chunk through to the
  network (they are not precached). The probe needs the desktop reachable
  once to load.
- `start(track)` (probe 2, second button) is meant for the on-device
  recognizer. With on-device off, the page warns that the speech service
  hears nothing from a track on Android, as `voiceSession.ts` records.
- The probe drives raw recognizers rather than `startDictation`, because
  that function's own restart policy would hide the gaps being measured.

Gates (frontend, `scripts/gates.sh` on the diff): all selected passed — brand-check, `git diff --check`, `npm run lint` (0 errors), `npm run build` (tsc + desktop, mobile, web bundles; the probe is its own chunk `assets/voiceProbe-*.js`, `silence.wav` lands in `mobile-dist/`), vitest `--changed` 38 files / 329 tests passed. No Rust change, so no cargo gate.
`scripts/privacy-check.sh`: passed (5 paths). It treats `silence.wav` as text (control bytes under 1 %), so it scans the file's lines; the reviewed-binaries line is recorded anyway, as the plan asks.

Flagged for user:
- The `.wav` content-type above: whether to add the `build.rs` row now or
  only if probe 3 `file` fails.
- The 6 s file length versus the plan's "a few hundred bytes".
- `voiceSession.ts` now exports three helpers, a small change in a file
  S3 owns.
- Never run on a phone; nothing here is verified live.

## Batch A review (branch `voice-a`)

**Commits:** `5e4936c9` holds the dictionary keys, the fixes and their
tests. This section is in the commit after it. Reviewed: `git diff
70344a96..voice-a` (S0, S1, S2 and the `build.rs` `wav` row).

### Mechanical: the reading keys

The 11 `voice.reading.*` keys from S2's table are appended after S1's
`voice.*` keys in all five dictionaries. en, de, es and fr are as S2 drafted
them. In it, the quoted command is now «riassunto», S1's
`voice.read.summary`, not S2's draft «riepilogo» (which would not have been
heard as "summary"). A new test, "the dictionaries' reading lines" in
`VoiceReading.test.ts`, builds `readingLabels((key, params) =>
translate(lang, key, params))` with no cast (it type-checks). For each
language it fills every label and checks that the quoted word of both long
lines is matched by `matchReading` as `summary`.

### Fixed (each with a regression test)

1. **`{text}` started inside a word.** Apostrophes split words, so "tell
   Claude that's wrong" filled `tell {agent} that {text}` with the text
   "s wrong", and "reply that's fine" replied "s fine". A `{text}` slot
   now starts only after whitespace. Test: "carries dictation as heard in a
   {text} slot" (two new cases).
2. **An exact long name was asked back.** The joined-letters score of
   "Project Alpha 2" against "project alpha" is 0.92, inside the 0.15
   margin, so "project Project Alpha" was ambiguous. Saying "Project Alpha"
   again in `resolveAmbiguity` stayed ambiguous, so it returned `null`: that
   project could be picked only by number. S1's "Alpha" vs "Alpha 2" worked
   only because the names are short. Now a name that scores 1 (letter for
   letter after the phonetic key) is picked when it is the only one; two
   exact ones ("Alpha", "Alfa") still ask back. Test: "takes a long name
   said exactly over the same name with a number".
3. **A personal command word of five or more words was never heard.**
   `commandWordLength` joined at most four tokens, and hyphens and
   apostrophes count as word breaks. The cap is gone; the prefix test still
   ends the walk at the first word that is off. Test: "may be a phrase of
   five words or more".
4. **A skip past the end came back to what it skipped.** "next" in the last
   section, or "next answer" in the last answer, ended reading but left the
   cursor where it was. With `follow`, the next `advance()` (when a new
   answer arrives) then read the rest of the skipped section or answer
   instead of the new one. Now the cursor goes to that answer's last chunk.
   Test: "a skip past the end never comes back to what it skipped".
5. **Chunk limit.** A `#` heading was one chunk of any length (a test
   heading of 80 words was a 399-character utterance, which Chrome on
   Android cuts off and never ends). The outline's first sentence was cut
   to `limits.maxChars` even when `maxChunk` was smaller. Headings now go
   through `speechChunks(…, maxChunk)`, and the outline uses the smaller of
   the two limits. Test: "cuts a long heading into chunks of at most the
   maximum too".

All five tests failed against the code before the fixes.

### Checked, no bug found

- **Probe gate:** `main.tsx` renders the lazy `voiceProbe` chunk only with
  `?voiceProbe` **and** `localStorage[storageDashKey("show-untested-tags")]
  === "true"`, the key `App.tsx` writes. Nothing else imports
  `voiceProbe.tsx`. Its only network call is a HEAD for `/silence.wav`; it
  makes no API call.
- **Phone bundle:** `voiceCommands.ts` imports `shared/voice`, `lib/fuzzy`
  (no imports) and `lib/i18n` (Zustand, React, `lib/brand`, `en`), with no
  Tauri anywhere in the chain. The phone already value-imports `lib/i18n`
  (`App.tsx`, `connection.ts`, `speechLang.ts`, …), so the matcher adds no
  new dependency. `npm run build` (which runs `mobile:bundle`) passes.
  `mobile-dist/` is gitignored, so there is nothing to commit.
- **Matcher:** the read phrases, yes words and no words of every language
  map to their own id with no collision; number words are normalized the
  same way in templates, names and utterances; `matchesPhrase` and
  `matchConfirm` (a plain yes gives `needPhrase` when a confirm phrase is
  set) behave as decision 5 says.
- **Brand:** the probe spells the name only through `BRAND.display`, and
  brand-check passes.

### Gates

`scripts/gates.sh --base 70344a96` (19 files: frontend + src-tauri), with
`CARGO_INCREMENTAL=0` and the worktree's own `target/` (on disk, not /tmp),
at a load of 50–78:

| Gate | Result |
|---|---|
| brand-check | PASS |
| `git diff --check 70344a96` | PASS |
| `npm run lint` | PASS (0 errors) |
| `cargo clippy -p tabtivity -p app-serverd --all-targets -D warnings` | PASS |
| `cargo clippy -p tabtivity --no-default-features --lib -D warnings` | PASS |
| `cargo clippy -p app-serverd --all-targets -D warnings` | PASS |
| `npm run build` (tsc, desktop, mobile, web bundles) | PASS |
| vitest `--changed 70344a96` | PASS — 728 files, 6852 tests (rerun with the dot reporter for the count, also all green) |
| `cargo test -p tabtivity -p app-serverd` | PASS |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | PASS |
| `cargo test --workspace` (run separately) | PASS — 13 test binaries, 5232 passed, 0 failed, 7 ignored |
| `scripts/privacy-check.sh` (staged) | PASS, 9 paths |

The voice tests are `VoiceCommands` 55 (S1's 53, plus 2), `VoiceReading` 34
(S2's 27, plus 2 tests and a 5-language `it.each`), `VoiceText` 13 and
`i18n` all green. `backend:stale` does not apply in a worktree: the running
window is the main checkout's build.

### Batch A review — flagged for user

- **Driving reads two long sentences whole.** In brief mode an answer is
  "short" when it has ≤ 2 sentences **or** ≤ 220 characters (S2 read the
  plan's "≤ ~2 sentences or ~15 s" literally), so a two-sentence answer of
  2 000 characters is read whole in the car. **and** would hold driving to
  ~15 s. I recommend **and** for `DRIVING_LIMITS`.
- **"Skip this answer" on an answer still streaming.** After the skip, the
  cursor sits at that answer's end. When the answer grows, a following
  `advance()` reads the new part. Should a skipped answer stay skipped? S6
  could keep a skipped-id set.
- **"back" twice needs no `advance` in between.** The mic is closed while a
  chunk is spoken, so a second spoken "back" usually arrives after the
  chunk ended and `advance()` ran: it is then a chunk-back again. Back
  twice works with the Media Session previous-track button during speech,
  or in a listen gap. S6 should know this.
- **Dictation that starts with the app's name** ("{app} crashes when …") is
  taken as a command ("Didn't catch that") and never reaches the draft.
  This follows from decision 1 and the `{app}` default, and probe items 5/7
  and the personal word are the remedy. It is recorded here only so it is
  not a surprise.
- **The exact-name rule (fix 2) is a small change to the "floor and
  margin" default.** If the recognizer drops a trailing "2", the matcher
  now opens "Project Alpha" instead of asking back.
- **A trailing "please" is cut from dictation** ("tell Claude to say
  please" → "to say"), because polite words are stripped at the utterance's
  end before the `{text}` slot. Minor; left as is.
- **`start(id)` on an answer with nothing to say yet** keeps the previous
  position. With `follow`, that is what lets a later `advance()` find the
  new answer, but if reading had been stopped in the middle of an older
  answer, `advance()` would resume that one. This is a judgement call for
  S6, not fixed.
- Not run live: no phone, no window.

## S6: read-aloud cursor (branch `voice-s6`)

**Commits:** `8458bcc9` holds the code, tests, dictionary keys, prefs keys and
untested rows. This section is in the commit after it. Base: `ca415f07`.

### What landed

- `mobile-web/src/speechOutput.ts` moves from its flat queue to the
  `voiceReading` cursor. The old exports keep their meaning: `speak`,
  `stopSpeaking`, `unlockSpeech`, `currentSpeechId`, `subscribeSpeech`. Plain
  `speak` (question read-outs, the probe) still queues sentence chunks; it
  does not go through the reading model. The `generation` counter is bumped
  by every stop and every move.
  - One cursor per tab in module state (`readings`). This is the read
    position, and it survives a reconnect, a tab switch and a remount, but
    not a reload. The set of turn keys already heard is kept with it, so an
    answer is not read twice and none is skipped across a remount. It holds
    tab ids, so nothing is written to storage.
  - The queue holds plain items and reading items (a reading item is a
    tab's cursor). The voice says `cursor.current()`. On `onend`, if
    `atSectionEnd()` (or every chunk, if asked), it awaits the
    `onSectionEnd` hook, then calls `advance()`. `null` ends that item.
- `useReadAloud` (`useSessionChat.ts`) feeds each tab's answer turns to its
  cursor (`feedReading`). Fresh answers (at most 3) are read with `follow`.
  While a hands-free turn is awaited (`holdReadingForTurn`), nothing is read
  entry by entry. `t` stays in the props type for the call site, but is
  unused: the labels are said in the speech language.
- `useHandsFree.ts` (today's Focus loop stands in for "armed"):
  - `awaitTurn` holds read-aloud for the turn.
  - When the turn is over, the turn's answers are read first (`readTurn`:
    the last 3 after the answer that was newest at the send). The mic opens
    once the voice is quiet.
  - A question the turn ended on is read after those answers.
  - With the mic open and nothing dictated yet, a whole utterance that
    `matchReading` hears (in the speech language) runs `runReadingCommand`.
    The tab must have a read position. "stop" stays the send guard's. The
    mic then waits for the voice alone (`handsFreeTurnOver({ reading:
    true })`, new in `handsFree.ts`).
- `components/MessageMenu.tsx`: Read aloud calls `readMessage(id, text,
  lang)`. For an answer of the open tab, this starts that tab's cursor on
  it (no follow), so the spoken moves go on from it. Anything else (a
  prompt, a subagent's message, a shell's screen bubble) is read as a
  one-off reading in full.
- **Brief / full and rate UI:** This device → **Reading aloud**
  (`components/ReadAloudSheet.tsx`, new, an `OptionSheet` with two groups):
  "Whole answers" / "Brief", and the speeds 0.7×–2×. There is one row in
  `screens/Home.tsx`.
- `speechLang.ts`: `speechLanguage(tag = speechTag())` turns a BCP-47 tag
  into an app `Language`, used for the labels and for `matchReading`.

### API for S3 / S4 / S5 / S10 (all in `speechOutput.ts`)

```ts
// feeding (S5 keeps useReadAloud as the feeder)
feedReading(tab, turnKeys, answers: ReadingAnswer[], lang): string[] | null  // fresh answer ids; null = first feed
readAnswers(tab, id): boolean          // read from id on, following into later answers
holdReadingForTurn(tab, hold); readingHeld(tab): boolean
readTurn(tab, sinceKey | null): boolean  // end of turn: last MAX_SPOKEN_AT_ONCE answers after sinceKey
readMessage(id, text, lang): void        // a message's Read aloud (replaces what is said)
leaveReading(tab)
// moves: tab omitted = the reading being said, else the last one read
readNext, readNextAnswer, readBack, readRepeat, readSummary, readAll, readCode, sayWhere: (tab?) => boolean
runReadingCommand(id: VoiceReadId, tab?): boolean   // matchReading's result, "stop" and rates included
stepRate(±1): number; setReadingRate(r); readingRate(); READING_RATES
setReadBrief(on); readBrief(); setReadingDriving(on)  // S10: brief + DRIVING_LIMITS
pauseReading(); resumeReading(); readingPaused()       // S4 play/pause
readingNow(): { tab, agent, position } | null           // S4 lock-screen card; subscribeSpeech fires per chunk
hasReadPosition(tab?): boolean
onSectionEnd(hook, { everyChunk? }): () => void         // S4 listen gaps
forgetReadings()                                        // tests
```

The `onSectionEnd` hook gets `{ tab, position, sectionEnd }`. Reading goes on
once its promise settles. A move made inside the gap (a command heard there)
bumps `generation`, and the step it was waiting for is dropped. There is one
hook at a time, and it is called after every chunk with `everyChunk`
(`voiceGapsPerChunk`).

### Hot-file additions

- **`prefs.ts`**: `MobileFlag` `voiceBrief` and `MobileChoice` `voiceRate`
  (string, one of `READING_RATES`). S3 still adds `handsFreeCommands`,
  `voiceDriving`, `voiceGapsPerChunk`, `voiceCommandWord` and
  `voiceConfirmPhrase`. Neither new key is cleared by `forgetDeviceData`
  (they are the owner's).
- **i18n** (en, de, es, fr, it; 10 each, appended at the end):
  `mobile.speech.reading`, `.readingHint`, `.modeGroup`, `.modeFull`,
  `.modeFullHint`, `.modeBrief`, `.modeBriefHint`, `.rateGroup`,
  `.rateValue` (`{rate}×`), `.rateNormal`. `mobile.speech.code` is no longer
  read by any code, but it was left in the dictionaries.
- **`untested.ts`**: new rows `mobile.speech.cursor` (the MessageMenu Read
  aloud row) and `mobile.speech.reading` (the This device row). The
  `mobile.voice.handsFree` row's text now also covers end-of-turn reading and
  the spoken reading commands.
- **`style.css`**: none.
- **Filemap**: no rows added (S11). `ReadAloudSheet.tsx` is new;
  `speechOutput.ts`'s row should say "reading cursor per tab".

### Choices and gotchas

- **Skipped streaming answer** (flagged in Batch A): no skipped-id set is
  needed. A skip past the end parks the cursor and ends the reading item. A
  new answer begins with `start`, so `advance()` is never called on a
  parked cursor except after an explicit "repeat" or "back".
- **`start(id)` on an empty answer** (flagged in Batch A): `begin` enqueues
  only when `start` returned a chunk, so a stale position is never resumed
  by itself.
- **Back twice:** as Batch A said, the mic is closed during speech in
  today's loop, so a spoken "back" always comes after the chunk ended and
  steps back by one chunk. A spoken "back, back" (the section before) needs
  S4's buttons or listen gaps.
- **Brief applies** to the tab's answers, including Read aloud on one of
  them. A one-off (prompt, subagent, screen) is always full. "summary" and
  "read all" are per answer, as in S2.
- **Rate change** cuts the current chunk and says it again at the new rate.
  A rate command with nothing being said repeats the current chunk, so the
  new pace is heard.
- **"where"** is said as a plain interjection, and then the chunk it cut off
  is said again.
- **A move** cuts off what was being said, drops that item (unless it is the
  same reading), and keeps the rest of the queue.
- **A new answer while one message is read from its menu** is started after
  that message (`then`), as the old queue did.
- **Labels** are said in the speech language. The dictionary is loaded on
  the first reading in that language, and the readings re-render when it
  lands; until then the English labels stand in.
- **Tab switch:** leaving a tab stops the voice (as before), but the tab's
  heard keys are kept. Back on the tab, up to 3 answers that arrived
  meanwhile are read (before, the first read after a remount was all
  history).
- **`readTurn` reads the last 3** of the turn's answers. A long agentic turn
  with many short in-between messages is read only from its third-last. The
  user can say "back" to go further.

### Gates

`scripts/gates.sh --base ca415f07` (18 files, frontend): brand PASS,
whitespace PASS, `npm run lint` PASS, `npm run build` PASS, vitest
`--changed` PASS (728 files, 6865 tests, all passed on the first run, rerun with the dot reporter for the count). There was no Rust change.
`scripts/privacy-check.sh`: PASS (18 paths). New and changed tests:
`MobileSpeechOutput.test.ts` 17 (was 1), `MobileTerminalReadAloud.test.tsx`
5 (one new hands-free end-to-end case; the old cases now expect the reading
model's chunks, "code block, one line"), and `MobileHandsFree.test.ts` +1.
The new hands-free case was checked to fail with the hold disabled. Not run
live. The phone bundle is stale once this lands (`npm run mobile:bundle`).

### Flagged for user

- Whether returning to a tab should read up to 3 answers that arrived while
  you were away (as built, following the plan's "survives tab switches"), or
  treat them as history as before.
- Whether the end of a hands-free turn should read the turn's last 3
  answers (as built) or only its final one.
- Whether a rate step should restart the current chunk (as built) or apply
  from the next one.
- The brief / speed sheet sits under This device for now. S8's voice sheet
  may absorb it.
- The es, fr and it strings were not reviewed by a native speaker.

## S6 review (branch `voice-s6`)

**Commits:** `5793ebbf` holds the fixes and their tests. This section is in
the commit after it. Reviewed: `git diff ca415f07..voice-s6` (`8458bcc9`,
`0d1d86bc`).

### Fixed (each with a regression test)

1. **A turn wait that ended early dropped the answers it held.** While a
   hands-free turn is awaited, `useReadAloud` marks each arriving answer as
   heard but does not read it (`holdReadingForTurn`), and `readTurn` reads
   them only from the wait's own timer. A wait that ended any other way
   (hands-free switched off in the Focus menu, the link lost, which clears
   the wait, or the mic's stop) released the hold without reading, so those
   answers were never spoken. Before S6 each was read as it arrived. Now
   the end of a wait whose answers were not read reads them (`readTheTurn`,
   the last 3, then following), unless the mic is open or being prepared.
   Test: "hands-free: a turn wait that ends early (…) still reads the
   answers it held", for both cases (`MobileTerminalReadAloud.test.tsx`).
2. **A send dictated over a held turn lost that turn's answers.** Tapping
   Dictate during the wait and sending again started a new wait from the
   newest answer, so the first turn's held answers were skipped. The turn
   record now carries `since` (where its reading starts) apart from `answer`
   (the turn-over check's key at the send): a send over a held, unread turn
   keeps the old `since`. Test: "hands-free: a send dictated over a held
   turn reads that turn's answers with the next".

Both tests failed against the code before the fixes.

### Checked, no bug found

- **Read-aloud without hands-free.** The Focus setting reads each new
  answer once: what a tab's first feed brings is history, answers that
  arrive while it is off or while dictating are marked heard, and more than
  3 at once are left to the eye, as before. MessageMenu's Read aloud reads
  an answer of the open tab on its cursor and anything else (prompt,
  subagent message, screen bubble) as a full one-off; its Stop row follows
  `currentSpeechId`. Every stop and move bumps `generation` before
  `speechSynthesis.cancel()`, and `said()` re-checks it after the listening
  gap's await, so a cut-off utterance starts nothing.
- **The flagged return-to-tab change is not a regression.** Tab switches
  are not the only remount: the idle lock (`auth` "locked") and a resume
  after a lost link (`auth` "loading", `restoreLastPlace`) also unmount and
  remount the Terminal (`App.tsx`, keyed by tab id). Before S6 every such
  remount made what arrived meanwhile history, so a kitchen phone that
  locked during a turn never read the turn's answer. The plan wants the
  position to survive reconnects and tab switches and "nothing read twice or
  skipped" (Defaults). A remount cannot tell a tab switch from a resume, and
  the 3-answer cap still keeps a long absence silent. Left as built; still
  listed for the user below.
- **The hands-free loop.** Nothing is read while `listening` (the feed and
  `readTurn` check it, and `useReadAloud` stops the voice when dictation
  starts). The mic opens only from the wait's timer, which needs
  `!speaking` and runs again once the voice is quiet. A reading command
  closes the mic (`endDictation` aborts) and the mic waits for the voice
  alone. "stop" / "stopp" never reaches `runReadingCommand`, so the send
  guard keeps it, and the cancel window always has a draft, so no reading
  command fires in it.
- **Reading commands** fire only on a settled hands-free segment, with an
  empty draft and a read position on that tab; `matchReading` compares the
  whole utterance (after the command word and polite words) with a phrase.
  Plain dictation (hands-free off) never calls the pick.
- **Chat bubbles:** no rendering change; the pill sits in the menu row.
- **Per-tab position:** the cursors, heard sets and holds are keyed by tab
  id; `activeTab` is set by the feed and cleared only by its own tab's
  leave, so a keyed swap cannot leak Read aloud onto another tab.
- **Prefs:** `voiceRate` round-trips as `String(rate)`, accepted only when it
  is one of `READING_RATES`; `voiceBrief` is a plain flag. Home's row reads
  both on mount.
- **i18n:** the 10 `mobile.speech.*` keys are in all five dictionaries.
- **Untested rows:** `mobile.speech.cursor` (MessageMenu row) and
  `mobile.speech.reading` (This device row) exist and both pills render
  through `isUntested`.

### Gates

`scripts/gates.sh --base ca415f07` (19 files, frontend), at a load of
about 50:

| Gate | Result |
|---|---|
| brand-check | PASS |
| `git diff --check ca415f07` | PASS |
| `npm run lint` | PASS (0 errors, no new warnings) |
| `npm run build` (tsc, desktop, mobile, web bundles) | PASS |
| vitest `--changed ca415f07` | PASS on the first run (1998 s; the script prints no counts) |
| `scripts/privacy-check.sh` (staged fixes) | PASS, 2 paths |

The voice files on their own (`MobileTerminalReadAloud` 8, which was 5,
plus `MobileSpeechOutput`, `MobileHandsFree`, `MobileTerminalHandsFree`,
`VoiceReading` and `VoiceCommands`): 6 files, 124 tests, all passed. There
was no Rust change, so no cargo gate ran. The phone bundle is stale once
this lands (`npm run mobile:bundle`).

### S6 review — flagged for user

- **S6 changed today's hands-free loop.** The plan gives end-of-turn
  reading to S5 "while armed", and says that with `handsFreeCommands` off
  the Focus row "works exactly as today". S6 made today's loop read at the
  turn's end and take spoken reading commands (`useHandsFree.ts`, an S5
  file). It works and the tests cover it, but it is a scope change: keep
  it, or move it behind `handsFreeCommands` when S5 lands?
- **Returning to a tab reads up to 3 answers that came meanwhile** (see
  above). The alternative, history on a tab switch but not on a lock or a
  resume, needs a navigation signal from `App.tsx` (S4's file).
- **Fix 1 after the mic's stop:** if the reader tapped Dictate during a
  wait and then stopped the mic, the turn's held answers are read right
  after the stop. Rare; before S6 they were read as they arrived.
- **For S4 (not reachable yet):** `readAnswers` returns true while the
  tab's reading is queued but paused (`pauseReading`), so a turn ending
  during a pause would neither speak nor open the mic. And `leaveReading`
  keeps `lastReading`, so a media button with no tab moves a reading of a
  tab that is no longer on screen. S4 should decide both.
- Not run live: no phone, no window.
