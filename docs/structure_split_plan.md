# Structure split, round 2 — plan

Status: plan only (2026-10-26). Scope cut on 2026-10-26 (user's call): this
round splits the phone composer and `AgentsPanel`, with `TexView` optional.
`CodeEditor` and `OllamaPanel` are deferred (see "Not done").

This round follows S7 of `docs/code_screen_plan.md`. S7's pure moves left five
pieces whole, because each is one function a move cannot cut
(`docs/code_screen_handoff.md`). This round cuts them by **ownership**: state
moves into the hook or component that is its only writer, and the parent
keeps only what more than one part reads. Line numbers are from develop
a0db126c.

## Why these three

Commits in the 30 days to 2026-10-26 (S7 split the files that day, so the
counts are for the parent files from before the split, filtered by commit
subject):

| Piece | Commits | Risk | In this round |
|---|---|---|---|
| Phone composer `useComposerSend` (76 inputs) | ~32 | medium | yes |
| `AgentsPanel` (992 lines) | ~29 | low | yes (pilot) |
| `TexView` (1,376) | ~8 | low–medium | optional |
| `OllamaPanel` (1,457) | ~5 | low | deferred |
| `CodeEditor` (2,979) | ~3 | high | deferred |

A file's size costs something only when someone has to open it. The split is
worth it where code keeps changing.

## Goal

Each piece becomes a short orchestrator plus parts that each own one concern,
with no hook taking more than ~20 inputs. Behaviour is unchanged; the existing
tests are the guard.

## Fixed decisions

1. **Ownership, not argument bags.** A state, ref or timer moves into the part
   that is its only writer. Grouping inputs into an object (`io`, `refs`,
   `voice`) only to lower the count is not done: it hides the coupling instead
   of removing it.
2. **Behaviour unchanged, tests unchanged.** No test file is edited except an
   import path. A test that needs more than that means the split changed
   behaviour; that goes under "Flagged for user" in the handoff, not into the
   test. The vitest file and test count must not drop (9,539 tests in 960
   files at a31aa5a3; re-count at the start of the run).
3. **Hook and effect order.** Hook call order may change: React only needs it
   stable from render to render. Effect order may change only for idempotent
   resets and cleanups, for example a tab-switch reset or a timer cleared on
   unmount. TexView's compile → pdf-version → forward-sync effects keep their
   current relative order, inside one hook.
4. **`exhaustive-deps` as in the neighbours.** Where an input is a stable
   setter or ref the rule cannot see, disable it at the site with the reason,
   following `screens/terminal/useComposer.ts`. Never add a dependency just to
   silence the rule (AGENTS.md). No new lint warnings and no new `any`.
5. **Flat siblings.** New files sit beside their parent, as S7 did: new phone
   hooks in `mobile-web/src/screens/terminal/`, the TeX parts in
   `src/components/embed/fileViewer/`, and the panel parts in
   `src/components/settings/`. No new subfolders.
6. **One component per agent step, one commit per new part,** so a bisect
   lands on a single cut.
7. **Hot shared files.** Each implementer lists the filemap rows it needs
   (`docs/filemap_frontend.md`) in the handoff, and the main agent applies them
   once at merge. No i18n keys or `untested.ts` rows are expected, since no
   strings change. A step that needs one says so in the handoff.
8. **When to start the composer step.** Start it only once the develop batch
   now waiting for phone testing has been tried on the phone. A
   behaviour-neutral refactor on top of untested work makes a regression
   harder to place. `AgentsPanel` and `TexView` can start at any time.

## 1 — `AgentsPanel` (992 lines, pilot)

`src/components/settings/AgentsPanel.tsx:67`. Its bulk is `agentCard`, a
340-line render function (:540–879).

| Part | From | Notes |
|---|---|---|
| `AgentCard` (child component) | :503–879 (`loginFacts`, `versionParts` :351–463, `agentCard`) | props: the agent, its log, error, version, update, remote target, chord, and the action callbacks |
| `useAgentActions` (install, update, remove, reinstall, recheck, remote install, dismiss version, logs, errors, busy maps) | :91–112, :178–350 | |

**Expected result:** `AgentsPanel.tsx` drops to ~350 lines. Six test files
cover it.

## 2 — Phone composer: `useComposerSend` (76 inputs)

`mobile-web/src/screens/terminal/useComposer.ts:150`, called at
`mobile-web/src/screens/Terminal.tsx:1272`.

**Why it has 76 inputs:** about 25 of them are state the screen declares only
to pass into the hook. The screen itself reads them in one JSX line or in the
tab-switch reset (`Terminal.tsx:1141–1211`). Examples: `sendNowAsking`,
`sendNowAnswer`, `settleQueue`, `sendTimers`, `undoRun`, `queuePulling`,
`subagentSending` and `editSending`.

The hook is replaced by six hooks. Each owns its state, does its own part of
the tab-switch reset in a `[tab.id]` effect, and returns what the JSX reads.

| Hook | Owns (moves out of `Terminal.tsx`) | Takes | Returns |
|---|---|---|---|
| `useDictationStop` — or folded into `useVoiceInput` (implementer's choice; one owner either way) | `recognition`, `voiceRequest`, `voiceProgress`, `listening`, `preparingVoice`, `voicePreview`, `voiceStatus`, `voiceFailure` (:637–641, :873–877) | `tab`, `connectedRef`, `dictateButton`, `setDraft`, `draftRef`, `submitDraftRef` | `endDictation`, `forgetDictation`, the voice state, `startVoice`/`stopVoice`/`cancelVoicePrep` |
| `useAgentWriter` | `sendTimers`, `settleQueue`, `commandSentAt`, `ctrl`, `sendFailed` (:643–649) and their cleanup from :1203–1207 | `tab`, `write`, `bracketedPaste`, `viewportRows`, `connectedRef`, `lastOutputAt`, `onPromptFailed(id)` | `type`, `press`, `later`, `clearPending`, `deliver`, `sendAgentText`, `interruptWith`, `typeOut`, `markCommandSent` |
| `useClearUndo` | `clearedAt`, `undoable`, `clearQueued`, `undoNote`, `undoing`, `undoRun`, `clearRefused` (:1004–1035, :1043) | `tab`, `transcript`, `agentAtWork`, `liveBusy`, `slashCliKey`, writer, `setPending`, `setTranscriptReload`, `transcriptVersion` | the state for the chips and the empty chat, `startedOver`, `clearConversation`, `undoClearConversation`, `forgetUndo` (the three resets `submitText` makes) |
| `useQueuedActions` | `sendNowWaiting`, `sendNowAsking`, `sendNowAnswer`, `queuePulling`, `queueNote` | `tab`, `pending`, `setPending`, `storedEntries`, `liveBusy`, `queuedShown`, `liveScreen`, `agentKey`, `screenRows`, `sendControl`, writer, `setDraft`, `composerInput` | `sendQueuedNow`, `pullQueued`, the state; `sendNowAnswer` for `useTerminalSocket` |
| `useHeldPrompts` | `editing`, `editingRef`, `editSending`, `editNote` (:718–725, :1014) | `tab`, `connected`, `draft`, `setDraft`, `pending`, `setPending`, `storedEntries`, writer, `composerInput`, `endDictation` | `holdDraft`, `startEdit`, `cancelEdit`, `submitEdit`, `resendPrompt`, `heldWaiting`, the state |
| `useComposerSend` (what is left) | `pendingId`, `sendHold`, `submitDraftRef`, `agentAtWorkRef`, `subagentSending` | `tab`, `bare`, `connected`, `aiOffRef`, `setAiOffAt`, `draft`, `setDraft`, `uploadsRef`, `setUploads`, `setLastSent`, `slashCliKey`, `usedSlash`, `setUsedSlash`, `transcriptCurrent`, `storedEntries`, `setPending`, `subagentPath`, `openStep`, `setSubagentNote`, `screenRows`, the five hooks above | `submitText`, `submitDraft`, `sendHoldHandlers`, `sendMarkup`, `refreshOutboxFile`, `subagentTarget` |

`pending`/`setPending` and `subagentNote` stay in the screen, because
`useSessionTranscript`, `useSessionEntries` and `useSubagentReader` read them
too.

**Order in `Terminal.tsx`:**

- The voice hook moves up to where the voice state is now (~:877), because
  `useTerminalSocket` (:1216) takes its refs and setters. `submitDraftRef`
  becomes a forward ref that the screen creates and `useComposerSend` fills,
  which is the same mechanism as today, created one step earlier.
- `useAgentWriter` goes after `pending` (~:988) and before `useTerminalSocket`.
  The model-picker sites that set `commandSentAt` (:1519, :1604) call
  `markCommandSent()`.
- `useClearUndo` goes after `useSessionTranscript` (:1229), because it reads
  `transcript`, and before `useSessionEntries` (:1236), which reads
  `clearedAt` and `undoing`.
- `useQueuedActions` and `useHeldPrompts` go after `useSessionEntries`, because
  they read `storedEntries` and `queuedShown`.

**Effect order:** the tab-switch reset moves out of the screen's one effect
into each hook's own `[tab.id]` effect. Every moved line is a `setX(initial)`
or a timer clear, so the order between them does not matter (decision 3). The
`pendingId` catch-up from `readHeld` (:1150–1151) stays with `setPending(held)`
in the screen's effect.

**Expected result:** no hook takes more than ~20 inputs, and four of the six
take ~10. `Terminal.tsx` loses ~25 declarations; the line count is roughly
unchanged.

**Covered by:** the `src/__tests__/mobile/MobileTerminal*.test.tsx` suite and
the phone composer, Focus and outbox tests. Run them first and record which
cover held prompts, Undo and Send now. A path with no test (Send now, the
Undo retry) goes in the handoff's click-through list.

## 3 — `TexView` (1,376 lines, optional)

`src/components/embed/fileViewer/TexView.tsx:124`. Do this step only if the
first two land cleanly.

| Part | From | Notes |
|---|---|---|
| `useTexCompile` (options, compiling, log, errors, warnings, pdf path and version, compile/driver/sync notes, `compile`, `compileRef`, the auto-engine probe) | :352–421, :484–500, :674–804 | keeps the compile → pdf-version effects together (decision 3) |
| `useTexRefs` (missing-ref creation, `followLink`, `linkRanges`) | :231–351 | |
| `useTexSync` (`openPdf`, `targetPdf`, `revealInPdf`, `forwardSync`, `onEditorFollow`) | :581–673 | takes `useTexCompile`'s pdf state |
| `TexNotices` (child component: the compiling bar, the notes, shell-escape, the errors and warnings lists, word count) | JSX :1050–1327 | props only; about 280 lines of JSX |

**Expected result:** `TexView.tsx` drops to ~550 lines.

## Not done

- **`CodeEditor`** (2,979 lines; ~3 commits in 30 days). It is the riskiest
  split for the least gain:
  - its wrap, measure and scroll layout effects (:555–760, :1566–1720) are
    fragile under WebKitGTK's fractional scaling;
  - only 2 test files render it directly;
  - it is rarely edited.

  If it becomes active again, the cut is: the core (`edit` plus the
  change-tint trail, :999–1142) first, then a hook per feature, each taking
  `edit`:
  - layout;
  - ghost completion, :426–613 and :1751–1915;
  - `\ref`/`\cite` completion, :521–553 and :1916–2085;
  - find/replace, :753–998 and :1488–1543;
  - grammar, :1144–1317;
  - hover preview, :1339–1487;
  - link hover, :365–425.

  `onKeyDown` (:2086–2318) stays whole: it dispatches across every feature.
- **`OllamaPanel`** (1,457 lines; ~5 commits in 30 days). Low risk, but it is
  rarely edited, so little is gained. If it becomes active again, the cut is:
  - an `OllamaRegistry` child component (state :181–196, logic :522–627, JSX
    :840–964 and :1347–1457);
  - an `OllamaVibeSection` child component (:130–135, :377–399, :655–829);
  - a `useOllamaPulls` hook (:163–179, :295–376);
  - a `useOllamaInstall` hook (:123–128, :400–486).

## Verification

Per step, `scripts/gates.sh`, which runs `npm run build`, `npm test`,
`npm run lint` and `scripts/brand-check.sh` for these paths. Then:

- the vitest file and test count are unchanged (decision 2);
- `git diff --check`;
- no new lint warnings (compare `npm run lint` warning counts before and
  after).

After the run, `scripts/gates.sh --all`. Never run live (AGENTS.md); the
handoff gives the user a click-through list for each step:

- **AgentsPanel:** install, update and remove a CLI, a remote install,
  reorder, chord hint, version dismiss.
- **Composer:** send, hold Send to interrupt, a held prompt with Edit and Send
  now, Cancel and edit, `/clear` then Undo, a word to a subagent, dictation,
  then switch tabs mid-dictation.
- **TexView:** compile, error click-through, forward sync, create a missing
  `\ref` file, word count.

## Organisation

Shape: **disjoint subsystems, mixed risk.** The three pieces share no code, so
there is no contract to land first:

- One implementer per step, each in its own worktree
  (`project_worktree_node_modules`: hardlink `node_modules`, check the test
  count).
- One step reviewer, on the composer only.
- One plan reviewer before any code, and one final reviewer over the whole
  range.

That makes 5 subagents with TexView, or 4 without. The main agent merges in
step order and applies the filemap rows once.

### Agent steps

| Agent step | Plan section | Files | Reviewer |
|---|---|---|---|
| A1 | 1 AgentsPanel (pilot) | `settings/AgentsPanel.tsx` + 2 new | final only |
| A2 | 2 Composer (after decision 8) | `screens/Terminal.tsx`, `terminal/useComposer.ts`, `terminal/useVoiceInput.ts` + 4 new | step reviewer |
| A3 | 3 TexView (optional) | `fileViewer/TexView.tsx` + 4 new | final only |

A1 and A3 can run together. A2 waits for decision 8. Handoff:
`docs/structure_split_handoff.md`.
