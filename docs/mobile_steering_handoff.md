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

## I2: the engine, the list levels, sheets, App wiring

Commit: see `git log` (subject `feat(phone-steering): engine, list levels, sheets, App wiring`).

### What exists now

- `mobile-web/src/steering/usePhoneSteering.ts`: `usePhoneSteering(input)` and the types
  `PhoneSteeringInput`, `SteeringBase`. Window capture `keydown`/`keyup`, `pointerdown`,
  `focusin`/`focusout`, window `blur`, `visibilitychange`; a `MutationObserver` (cursor repair,
  engine rule 7) that runs only while the mode is on; a `useVisiblePoll` of `getActivity()` every
  5 s while on. Listeners are added once per `enabled`; every other input is read through a ref.
  Nothing calls `stopPropagation`. With the mode off only the two chords (and the keyup of a key it
  prevented) are touched.
- `mobile-web/src/steering/SteeringConfirm.tsx`: the W confirm; it subscribes to `confirm` only.
- `steeringState.ts` gained `SteeringView { level, paused, typing, sectionLabel }`, the snapshot
  field `view` (null while the mode is off) and `setView`. The engine publishes it after every
  handled key, on focus changes and from the observer, so a sheet that opens later is seen.
- `steeringDom.ts` gained `cursorRow(list, from)` and `rowAct(id, act, behindSheet = false)`; the
  confirm needs `behindSheet` because the screen behind a sheet is `inert`.
- `App.tsx`: `usePhoneSteering` is called right after `openSection` is defined, before the first
  early return, `enabled: auth === "paired"`. `base`: `terminal` is `inside`; `tabby` or a tab
  other than Projects is `section`; a project is `tabs`; else `projects`. `sectionLabel` is the tab's
  `mobile.tabs.*` key, or `assistant.title` for Tabby. `<SteeringConfirm />` sits after the screen
  inside the tabbed branch's `<BackNest>`.
- Markers (attributes only): `data-steer-row` on Home's project cards (box heads and members too),
  `.home-needs-row`, `.activity-card`, both `.tab-card-open` buttons (a file card uses its swipe
  key); `data-steer-act` `menu`/`close` on the cards, `new` on the + FAB and Home's new-project
  button; `data-steer-confirm` on an `OptionSheet` option whose key is `"confirm"` (also
  `DivergedSheet`'s, so Y works there). Home answers the find request.
- Guards: `ProjectFiles.tsx` Esc listener and `rowDrag.ts` grip `onKeyDown` return on
  `defaultPrevented`.

### What I3 must use or fill

- **Inside registry.** `registerInside(target)` from `steeringState`; the engine calls
  `getInside()` lazily at the key, so a target registered after entering the mode works.
  `answer(n)` results: `none` flashes `noQuestion`, `missing` flashes `noOption {n}`, `answered` and
  `freeText` flash nothing. `focusComposer()` `"blocked"` flashes `blocked`. After `registerInside`
  or a question change call `refreshInside()` so the bar's `question` flag moves.
- **Handoff.** The engine blurs the composer itself after an Enter that left it empty (checks at
  0 ms and 250 ms), so `Terminal.tsx` is not wrapped. Esc in any field blurs it. Typing detection
  asks `typingField(...)`; the composer is a field inside `.composer-field` (the bar's
  "Enter sends" text keys off `view.typing === "composer"`).
- **The bar.** Mount `<SteeringBar />` in the three early-returning branches of `App()` (terminal,
  tabby, tabbed) as a fragment around each. Read it with `useSteering()`: `active`, `view`
  (`level`, `paused`, `typing`, `sectionLabel`), `flash`, `legendFolded`, `activity.tabs` for the Q R
  X counts (`statusCounts`), `question`/`hasInside`. Keys for a level come from
  `phoneBindingsFor(level)` / `phoneActionKeys` (merge rows of one action; skip `legend` in the
  list if you show it as the badge). Hide the status keys at count 0.
- **`data-steer-scroll`** on `.readable-output` is yours (Terminal.tsx); `scrollStep` falls back to
  the visible `.xterm-viewport`.
- **CSS** (yours): the cursor is real `:focus`, under `html[data-steering]`; `html[data-steer-bar]`
  is set only while active and not folded. A row may need `scroll-margin-bottom`.

### Choices where the plan was open

- **Digits on Home** count the project rows (`.home-project-card`), not Needs-you rows; with none
  (the Agents list) they count the rows there.
- **Q R X record `jumpBack` on every jump** (the place before the most recent jump); Backspace
  restores it and clears it (depth 1).
- **`openSection` wrapper does nothing for the section you are already on** (the tab bar reseeds it;
  a key must not lose Mail's folder), and nothing for a hidden section.
- **`restore`** leaves `tab`/`projectView` alone for a terminal place (only `terminal` and `tabby`
  are set); for a list place it sets `tab`, and `projectView` when the section is Projects.
- **Enter on a card's other button** (✕, ⋯, the model chip) opens the card, as the cursor is the
  card; ← / S still go back. The cursor is moved to the card's row first.
- **Cursor memory is per list level** (`projects`, `tabs`), set on every focus that lands on a row,
  so Back lands on the row you left. `/` forgets the Projects one so Esc lands on the first result.
- **Esc in a sheet's field** blurs it and moves the cursor to the next control; elsewhere the
  repair puts it on a row.
- **A held key** is still prevented but does nothing unless it is up/down.
- **`isIgnoredKey` runs first**, so Alt+Space is the only Alt key the engine sees.

### Gotchas

- `useSteering()` re-renders its caller on every change (flash, activity every 5 s, view). The
  App and `SteeringConfirm`/Home read single fields through `useSyncExternalStore`; keep the bar the
  only heavy subscriber.
- jsdom delivers `focus()` without `focusin` ordering guarantees you may expect; `view` is published
  in a microtask after focus changes, so tests `waitFor` it.
- Window-level keys do not reach `document` listeners in tests: fire on `document.body` to see the
  event bubble to document (the engine uses capture on `window`).
- The cursor-repair test uses a plain `blur()` plus an appended node; jsdom does not blur a moved node.

### Gates

- `scripts/gates.sh` (diff vs HEAD): brand, whitespace, `npm run lint` (0 errors, no new warnings),
  `npm run build` and `vitest --changed` all pass; no Rust gate selected.
- New tests, all green: `MobileSteeringLists` 23, `MobileSteeringRegion` 9, `MobileKeydownGuards` 5,
  plus 2 added cases in `MobileSteeringDom` (`cursorRow`, `rowAct` behind a sheet). The existing
  `MobileBackStack`, `MobileFilesLibraryViewer`, `MobileTerminalOutbox`, `MobileAppSession`,
  `MobileHome`, `MobileNeedsYou` and the desktop `SteeringBindings` suites pass unchanged.
- Plain `npm test`: 1109 files, 11460 tests, 3 failures, all independent of this change:
  `i18n.test.ts` "every language covers every English key" (the `agents.tools.*` /
  `agents.defaults*` baseline), `CursorPacks.test.ts` (bare `cursor:` in the stylesheet) and
  `TypeScale.test.ts` (an `11px` font size in the desktop stylesheet). The last one is not in the
  list I1 recorded; no CSS is touched on this branch, so it is also at the base. The flaky
  `MobileTerminalTranscript` passed this run.

### Flagged for user

- No App-level test mounts `<App />` with the engine: the wiring in `App.tsx` (`base`, `place`,
  `openSection` wrapper, `restore`, `findProject`) is covered by type-check and the harness tests
  of the engine and Home, not end to end. It needs the manual walk (plan, Verification 3-7).
- Not live-verified: real Bluetooth keyboards on Android and iOS (Shift+Space, hardware Esc,
  Alt+Space), cursor repair after a real remount, and the on-screen look (no CSS until I3: the cursor
  has no outline yet, so a phone build of this commit steers invisibly).
- No new i18n keys were needed; no plan deviation beyond the choices above.
