# Keyboard steering on the phone: handoff between implementers

Plan: `docs/mobile_steering_plan.md`. Each implementer appends a section. Do not push.

## I1: keys, state, DOM helpers, strings

Commit: see `git log` (subject `feat(phone-steering): shared key names, phone table, state, DOM helpers`).

### What exists now

All under `mobile-web/src/steering/` unless noted; none of it imports Tauri or `src/stores`
(`MobileSteeringImports` walks the graph).

- `src/lib/shortcuts/keyNames.ts`: `MODIFIER_KEYS`, `normalizeKey`, `isLoneModifier`.
  `shortcuts.ts` imports and re-exports the two functions; `steeringBindings.ts` imports from
  `./keyNames` and now exports `keyMatches(key, e)`. No table line changed.
- `modalFocus.ts`: `focusables(root)` is exported.
- `phoneSteeringKeys.ts`
  - Types: `PhoneLevel`, `PHONE_LEVELS`, `PhoneSteeringAction`, `PhoneBindingDef`, `PhoneKeyEvent`.
  - Table: `PHONE_STEERING_BINDINGS` (resolution order).
  - Resolve: `phoneSteeringActionFor(e, level, overrides): PhoneSteeringAction | null`,
    `phoneDigit(e, overrides): number | null` (1-9; call it after the action is `openRow` or `answer`),
    `acceptsRepeat(action): boolean` (true for `up`, `down` only).
  - Table views: `phoneBindingsFor(level)`, `phoneKeys(def, overrides)`,
    `phoneActionKeys(action, level, overrides)`, `phoneRowKeys(def, overrides = null)`,
    `findPhoneSteeringConflicts(overrides)`.
  - Events: `isSpace(e)`, `typingField(target)`, `isTypingTarget(target)`,
    `isEntryChord(e, target)`, `isIgnoredKey(e)`, `isHardwareKeydown(e, target)`.
- `steeringState.ts`: `useSteering()`, `getSteering()`, `subscribe`, `setActive`,
  `setLegendFolded`/`toggleLegendFolded`, `flash(key, vars?)`/`clearFlash()` (about 3 s),
  `setJumpBack(place | null)`, `setActivity(tabs, fetchedAt?)`, `setConfirm`,
  `requestFind()`/`takeFindRequest()`, `registerInside(target | null)`, `getInside()`,
  `refreshInside()`, `resetSteeringForTests()`; types `Place`, `InsideTarget`, `AnswerResult`,
  `SteeringSnapshot`, `SteeringFlash`, `SteeringConfirm`. `setActive` sets and clears
  `html[data-steering]` and `html[data-steer-bar]`.
- `steeringDom.ts`: `OWN_KEYS_SELECTOR`, `isReachable`, `topModal`, `ownKeysUp`, `rows`, `rowId`,
  `rowById`, `walk(list, 1 | -1, from)`, `focusRow`, `controls(modal)`, `press(el)`
  (returns `"clicked" | "focused"`), `rowAct(id, act)`, `screenAct(act)`, `scrollTarget`,
  `scrollStep(dir, page?)`, `toLatest()`. The three act helpers click and answer a boolean.
- `phoneStatusJump.ts`: `kindOf(tab)` (`"ask" | "working" | "done" | null`),
  `nextStatusTab(list, currentTabId, kind, backwards?, seen?)`, `statusCounts(list, seen?)`.
- i18n: all 29 `mobile.steering.*` keys in the five dictionaries, after `mobile.status.cached`.
- Test helper `src/__tests__/helpers/mobileSteering.ts`: `keyInit`, `press`, `codeFor`,
  `stubLayout()` (returns `{ scrollIntoView, restore }`), `resetSteering()`.

### Choices where the plan was open

- **Several rows per action.** An action that needs other keys or another label on another
  level has more than one row: `exit` (Space on all five levels; Escape on the four non-sheet
  levels), `back` (S and the left arrow everywhere; Escape too over a sheet), `up`/`down`
  (label Move on lists and sheets, Scroll inside a tab). The legend must go through
  `phoneActionKeys(action, level)` or `phoneBindingsFor(level)` and merge rows that share an
  action. `findPhoneSteeringConflicts` ignores rows of the same action.
- **`desktop` may be an array** (`PhoneBindingDef.desktop: SteeringAction | readonly SteeringAction[]`).
  `openRow` and `answer` use the nine slot actions; `newTab` unions `newShell` and `newTabMenu`.
  A row may also carry `keys`, which are added to the desktop's (`open` = right keys + Enter).
- `phoneSteeringActionFor` returns the action only; a digit row returns `openRow` or `answer`
  and the engine asks `phoneDigit` for N.
- `search` takes the desktop `jumpProject` key (`/`), not the region-only `search` action.
- `nextStatusTab` never returns the current tab: with only the current tab matching, it
  returns null (the engine would flash "No tab waits on you"). `done` means unseen-done and
  reads `readSeenDone()` unless a `seen` list is passed.
- `ownKeysUp()` follows engine rule 10 literally: a surface on top, or a modal inside it.
  FilesLibrary's sheets are siblings of the library (the library goes `inert`), so they are
  walked as a region.
- `typingField` treats `<select>` as a typing target for the handoff but as empty for the
  entry chord (nothing to type into).
- `press(el)` focuses a text field instead of clicking it; checkboxes and buttons are clicked.
- `isHardwareKeydown` counts F1-F24, arrows, Escape and Tab as hardware-only.

### Gotchas

- `data-steer-row` ids are compared as strings (`rowById`), never put into a selector.
- `walk` takes the nearest ancestor of the focused element that holds exactly one row, so
  focus on a card's own buttons counts as the card's row; `document.body` counts as none.
- `resetSteeringForTests` also clears `findHandled`, so `takeFindRequest()` starts clean.
- `scripts/gates.sh` runs `vitest --changed` (tests related to the diff); the other steps
  should still run a plain `npm test` once before the review.

### Gates

- `brand-check`, `git diff --check`, `npm run lint` (0 errors) and `npm run build`: pass.
- New tests: Keys 38, Imports 2, Dom 29, StatusJump 10, all pass; desktop `SteeringBindings` and
  `Shortcuts` suites unchanged and green.
- Full changed-related vitest run (826 files, 8174 tests): 3 failures, none from this change:
  - `src/__tests__/shell/i18n.test.ts` "every language covers every English key": already red
    at the branch base. `agents.tools.*` and `agents.defaults*` (from the local-models work)
    are missing in es, fr, it (and two in de). No `mobile.steering.*` key is missing. The main
    checkout's working tree already holds those translations, so they were not added here.
  - `src/__tests__/theme/CursorPacks.test.ts` (bare `cursor: pointer;` / `cursor: text;` in
    the stylesheet): unrelated, no CSS touched here.
  - `src/__tests__/mobile/MobileTerminalTranscript.test.tsx` ("keeps the chat while a /clear
    ..."): passes alone, fails under suite load.

### Flagged for user

- The baseline i18n parity failure above makes `npm test` red on this branch until the
  local-models translations land.
- No plan deviation except the array-typed `desktop` and the multi-row actions above.
