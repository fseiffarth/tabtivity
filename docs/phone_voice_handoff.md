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
