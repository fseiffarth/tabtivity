# Phone hands-free voice: implementer handoff

Each agent step of `docs/phone_voice_plan.md` appends its section here: what
landed, the interfaces it exposed, the hot-file additions for the main agent,
and what it left open.

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
