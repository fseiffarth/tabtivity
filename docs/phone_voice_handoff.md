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
