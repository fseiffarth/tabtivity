# Keyboard steering on the phone

Status: **plan only, 2026-11-09. Nothing here is built.** Branch `mobile-steering`
(worktree `.claude/worktrees/mobile-steering`, based on develop `b3239822`).

## Why

The user asked (verbatim): *"Add also steering mode to the phone, eg if i have
connected a bluetooth keyboard to my phone, make it similar to the desktop one"*.

On the desktop, Shift+Space enters a mode where the keyboard alone walks projects → tabs →
inside a tab, plus a cursor for dialogs and menus. E S D F work as arrows. Q R X jump to
the next tab that needs an answer, is working or is done. Digits answer an agent's
question, a key opens a box to type to the agent, W closes with a confirm, and a bottom
bar lists the keys. The phone PWA (`mobile-web/`) has none of this. A phone or iPad
with a Bluetooth keyboard can only Tab through controls, and Esc closes a few viewers.
This plan brings the same mode, with the same keys, to the phone surfaces: Home → Project → Terminal, sheets and the
Mail / Calendar / To-do sections. Touch-only users see nothing new.

## What exists (read before building)

- **Desktop steering**: `src/lib/shortcuts/steeringBindings.ts` (the bare-key table,
  `steeringKeys`, `steeringActionFor`, `steeringKeyLabel`), `shortcuts.ts` (the
  `steeringMode` chord `{ key: " ", shift: true }`, the `STEERING_KEYS` legend rows),
  `src/stores/keyboardSteering.ts` (levels `projects | panes | tabs | scroll | region`),
  `src/hooks/useKeyboard.ts` (the handler).
- **Not in this branch:** `src/lib/shortcuts/steeringAnswer.ts` (digits answer a
  question) and a desktop key rework. Both exist only as **uncommitted** edits in the main
  checkout's develop working tree. In that rework Esc exits, Enter = work, Space = the
  prompt box and Backspace = `jumpBack`; at HEAD Space exits and I opens the prompt. The same
  working tree also has uncommitted edits to `steeringBindings.ts`, `shortcuts.ts`, all five
  i18n dictionaries, `src/lib/untested.ts`, the filemaps, `mobile-web/src/screens/Terminal.tsx`
  and `mobile-web/src/style.css`. This plan is built so that it does not depend on that work
  landing, and so that it follows the work once it does (decisions 3 and 4).
- **The phone imports pure `src/` modules by relative path.** It does this about 75 times for
  `src/lib/i18n`, and also for `src/lib/untested`, `brand`, `persist` and others, all
  covered by `tsconfig.mobile.json` (`include: ["mobile-web/src"]`, `types: []`; a file
  outside it is type-checked once the phone imports it) and `vite.mobile.config.ts`. It
  imports **no** `@tauri-apps/*`. `steeringBindings.ts` imports `normalizeKey` /
  `isLoneModifier` from `shortcuts.ts` (a cycle: `shortcuts.ts` imports the bindings back),
  and `shortcuts.ts` imports `superKey.ts`, which imports `@tauri-apps/api/core`. As things
  stand, importing the bindings from the phone would pull Tauri into the phone bundle.
  Verified in review: that is the only value import the bindings have besides a type
  (`TranslationKey`), so moving the three names to `keyNames.ts` makes them phone-safe and
  also ends the cycle.
- **Phone navigation** (`mobile-web/src/App.tsx`):
  - React state, not routes: `tab` (projects / todo / mail / calendar), `projectView`
    (home | project id), `terminal` (project + `TabRow`) and `tabby`.
  - `openTerminal(project, row)` and `openSection(tab)`.
  - Back goes through `backStack.ts` (`useBackLayer`, `goBack()`). Every sheet and viewer
    registers a layer.
  - Sheets are `role="dialog" aria-modal="true"` with `useModalFocus` (`modalFocus.ts`):
    focus goes to the first choice, Tab stays inside the sheet, siblings are made `inert`.
- **Rows the cursor will walk**:
  - Home: `projectCard` `<button className="card">` (`Home.tsx` ~294; boxes use it too),
    `NeedsYou` `.home-needs-row` (`NeedsYou.tsx` ~173, `disabled` when the tab is not
    `available`), Agents view `.activity-card` (`Activity.tsx` ~151, same).
  - Project: `TabCard`'s `.tab-card-open` overlay button (agent/shell cards ~212, file
    cards ~281), with `.tab-card-more` and `.tab-card-close` beside it (`TabCard.tsx`
    ~187–212); the + FAB (`Project.tsx` ~855, a `useTapHold` button: its `onClick` is the
    tap, so `.click()` works).
  - A phone close is one tap with no confirm (`Project.tsx` `close`, ~553).
  - Opening a terminal **unmounts** Home/Project (`App.tsx` returns the `Terminal` branch
    early), so going back remounts them and their lists load again.
- **Answering a question on the phone**: `useLiveQuestion`
  (`mobile-web/src/screens/terminal/useLiveQuestion.ts`, called at `Terminal.tsx` ~2066)
  gives `answerQuestion(option)` and `answerQuestionText`; `QuestionList` (`Terminal.tsx`
  ~494, rendered ~2587 in the Focus view) maps `prompt.options` one-to-one, in order, onto
  `QuestionRows` (`components/QuestionRows.tsx`: a `ul.question-list`, one `li > button`
  per option; a free-text row opens a `textarea autoFocus` under it). `SelectOption.number`
  and `UNNUMBERED = 0` are in `mobile-web/src/terminal/selectPrompt.ts`. The composer
  textarea is `disabled` while a question is live (`chatInputBlocked`).
- **Chat scroller**: `.readable-output` (`Terminal.tsx` ~2508, Focus view). The terminal
  view has an `.xterm-viewport`; xterm there runs with `disableStdin: true`, so no key ever
  types into it. `.terminal-screen` gets an inline `height` from `viewportHeight`
  (`Terminal.tsx` ~2394), which beats any stylesheet height.
- **Existing phone key handlers**: `keydown` listeners in `Project.tsx`, `useOutbox.tsx`,
  `OutboxViewer.tsx`, `FilesLibrary.tsx` (×2) and `FavoritesPage.tsx` all return on
  `event.defaultPrevented`. Two do not:
  - `ProjectFiles.tsx:80`: Esc → `onClose`.
  - `rowDrag.ts:131`: grip arrows move a row.

  `rowDrag.ts:131` is a React `onKeyDown` on the grip, not a listener. The composer
  (`Terminal.tsx` ~2775) sends on Enter and skips `isComposing` / `keyCode 229`.
  `FilesLibrary` already walks its items with arrows for an iPad keyboard.
  The idle-lock listener (`App.tsx` `ACTIVITY_EVENTS`, ~132) is on `document` in the
  capture phase, passive. `useModalFocus`'s Tab trap is a `document` bubble listener. A
  `window` capture listener runs before both. No phone code handles `keyup`.
- **`backStack.goBack()` is asynchronous.** It calls `history.back()`; the layer's
  `back()` runs on the `popstate` that follows, and it does nothing when no layer is
  registered. The `App` registers one layer for terminal / section / project, so S on
  Home itself does nothing. Tests must `await` it (`waitFor`).
- **jsdom has none of**: `scrollIntoView`, element `scrollBy`, `checkVisibility`, layout
  (`offsetParent` is null, `getClientRects()` is empty, `clientHeight` is 0) or `inert`
  behaviour. `scrollTop` is writable and `focus()` works. Existing tests stub
  `Element.prototype.scrollIntoView` themselves.
- **Cross-project status data**: `getActivity()` (`api.ts` ~194) returns every working /
  question / interrupted / done agent tab as an `ActivityTab` (a `TabRow` plus
  `project_id`, `project_label`). That is enough for Q R X. The phone's own notion of
  "done" is unseen-done (`seenDone.ts`: `readSeenDone`, `isUnseenDone`), as `NeedsYou`
  lists it. `NeedsYou` and `Activity` already poll `getActivity` with `useVisiblePoll`
  (`mobile-web/src/visiblePoll.ts`). The bridge does not carry `settings.steering_keys`;
  the field is only in desktop settings.
- **Conventions**:
  - Phone CSS is written in plain hex and themed at build time (`themeColors.ts`).
    Verified: `vite.mobile.config.ts` runs it on every file whose path contains
    `/mobile-web/src/`, so `steering/steering.css` is covered. The vitest config has
    `css: false`, so CSS never affects a test.
  - `MobileAnimatedShadowBlur.test.ts` reads a fixed `SHEETS` list (`style.css`,
    `themes.css`), so a new sheet is invisible to it until added.
  - Phone untested pills: `isUntested("<id>") && <span className="untested">{t("mobile.newTab.untested")}</span>`.
    The id must be a string literal: `scripts/untested.mjs check`, run by
    `src/__tests__/shell/UntestedRegistry.test.ts`, fails on a register row with no call
    site **and** on a call site with no row. Rows therefore land in the same step as
    their pills.
  - i18n: `useT()` from `src/lib/i18n`. There are five dictionaries (`en`, `de`, `es`,
    `fr`, `it`, in `src/lib/i18n/`); `src/__tests__/shell/i18n.test.ts` checks both ways,
    `{placeholder}` survival and that the app's name is only `{app}` / `{slug}`.
  - Phone tests: `src/__tests__/mobile/*` (Testing Library, `fireEvent.keyDown(window, …)`
    without a `code`). Source-scan tests read files with `node:fs` under a
    `// @ts-expect-error node:fs has no type declarations` line, as
    `MobileAnimatedShadowBlur.test.ts` does.
  - Phone QA todos: `todo/group-h-crossplatform.md` (the phone's group; last item
    `31cf`) with ✅/❌ pairs for Android and iOS, as the Back-stack item has.

## Fixed decisions (reviewers may not undo them)

1. **Phone levels map onto the desktop's like this.** The desktop's subwindow level has no
   phone surface and is dropped.

   | Desktop level | Phone level | Phone surface |
   |---|---|---|
   | projects | `projects` | Home: Needs-you rows, project and box rows, Agents list, search results |
   | panes + tabs | `tabs` | Project screen: tab cards and file cards |
   | scroll | `inside` | Terminal screen (chat or terminal view) |
   | region | `region` | Whatever `aria-modal` sheet or menu is on top |
   | (none) | `section` | Mail, Calendar, To-do, Tabby: their controls, walked generically |

   The engine never stores the level. It derives it from App state (base level) and the DOM
   (a sheet on top → `region`). The legend's ladder reads **Projects › Tabs › Inside**, with
   **Sheet** or the section's own name off the ladder.

2. **The cursor is real DOM focus.** On a list level the cursor is the focused
   `[data-steer-row]` button. In a region or section it is the focused control, walked
   through `modalFocus`'s focusables list (exported). Moving it calls
   `focus({ preventScroll: true })` and then `scrollIntoView({ block: "nearest" })`.
   Reasons:
   - It survives the 5 s list re-polls, whereas a class set by hand is wiped when React
     re-renders `className`.
   - It agrees with `useModalFocus` and with screen readers.
   - It needs no cursor state.

   `html[data-steering]` turns on a strong outline for `:focus` (not only `:focus-visible`,
   which iOS sets unreliably). Rows carry their id (`data-steer-row="<id>"`), so the
   cursor lands back on the row a level was left from.

3. **Pure logic is shared and the desktop table is the source of key defaults.**
   - A new dependency-free `src/lib/shortcuts/keyNames.ts` takes over `MODIFIER_KEYS`,
     `normalizeKey` and `isLoneModifier`. `shortcuts.ts` re-exports them, so desktop
     imports stay unchanged.
   - `steeringBindings.ts` imports them from `keyNames.ts` and exports its private
     `keyMatches`. That makes `steeringBindings.ts` safe for the phone bundle (its only
     other import is a type).
   - The phone has its own table (`PHONE_STEERING_BINDINGS`) with phone levels. Each row
     either names a desktop action (`desktop: "up"`), whose keys then come from
     `steeringKeys(action, overrides)`, or carries keys of its own (`keys: ["Enter"]`). The
     phone therefore follows any change to the desktop defaults, including the in-flight
     Esc / Space / Backspace rework, without edits.
   - A source-scan test stops Tauri or `src/stores` imports from entering the phone's
     steering import graph.
   - Desktop-only parts stay on the desktop: panes, subwindows, the WebKit region walker,
     `steeringCaps`, `steeringAnswer`.

4. **v1 uses the default keys only.** The phone does not honor `settings.steering_keys`,
   because the bridge does not carry it. The phone table already takes an `overrides`
   argument, which v1 passes as `null`, so the later wire-up touches no table code.
   Phone-only rows:

   | Row | Keys | Note |
   |---|---|---|
   | `open` | Enter | |
   | `jumpBack` | Backspace | Switch to `desktop: "jumpBack"` once that action is in `steeringBindings` |
   | `exit` | desktop `exit` keys ∪ Escape | At HEAD that is Space + Esc; after the rework, Esc |

5. **Entry and exit.**
   - **Shift+Space** (the desktop's chord) enters when focus is not in a text field, or is
     in an **empty** one: a leading space is never meaningful typing. This mirrors the
     desktop's typing-burst guard.
   - **Alt+Space** enters from anywhere, text fields included. It types no ordinary text,
     and it avoids the Shift+Space language switch some Android keyboards (Samsung) offer
     for hardware keyboards.
   - Both chords toggle: they are checked before the table, so they also leave the mode.
   - The mode is also left by `exit`, by any `pointerdown` (touch, pen or mouse: the user
     went back to the glass), when auth leaves `paired`, and when the page goes hidden.
   - The engine ignores every event with `ctrlKey` or `metaKey`, with `isComposing`,
     `keyCode === 229`, or `key` equal to `"Unidentified"`, `"Process"` or `"Dead"`, and a
     lone modifier press. Those belong to the OS, the browser or the IME (iOS Cmd combos
     and Ctrl+Space language switching among them). The key matching rules for Alt, `code`
     and `repeat` are in "Engine rules (added in review)" below.

6. **Typing is never eaten.**
   - **While the mode is off**, the listener only ever acts on the two chords. It calls
     `preventDefault` on nothing else.
   - **While the mode is on**, it calls `preventDefault` on the keydowns it swallows (those
     the table resolves; every other key, Tab included, passes untouched), and on the keyup
     of every key whose keydown it swallowed (even after the mode has been left), so a
     focused button's native Space/Enter activation cannot fire. It
     **never** calls `stopPropagation`: the idle-lock activity listener and React must still
     see the key.
   - **Other handlers** are relied on to honor `defaultPrevented`, which is already the
     phone's convention. The two exceptions (`ProjectFiles.tsx:80`, a `window` listener, and
     `rowDrag.ts:131`, a React `onKeyDown` on the grip) get the guard, and a source-scan test
     keeps every future `addEventListener("keydown"` honest.
   - **Handoff.** While a text field has the caret, the mode passes every key through
     except Esc (back to steering) and the two chords. This is derived from focus, so a
     field that took focus by itself (`autoFocus` in a sheet, Home's search) is covered
     too, not only the ones steering focused:
     - the composer (`type`);
     - a free-text answer row (a digit on a free-text option);
     - Home's search (`/`);
     - any field the region cursor lands on.

     In the composer, Enter sends as it does today, and steering then resumes on `inside`
     (the engine blurs the composer once Enter has left it empty; `Terminal.tsx` is not
     wrapped for it). Shift+Space in a non-empty field types a space.

7. **Hardware-keyboard detection is used only for the one-time tip** (open question 2).
   The engine itself simply answers its chords.

   A keydown counts as hardware when:
   - its target is not editable (no on-screen keyboard can be up without a focused field);
   - or it carries Alt;
   - or it is a key soft keyboards do not send: arrows, Escape, Tab, F-keys.

   The 229, `Unidentified` and composing cases never count.

8. **Keys per level.** Desktop-derived keys are given at their HEAD defaults.

   | Level | Keys |
   |---|---|
   | All but `region` | E/↑ D/↓ move the cursor (on `inside`: scroll). S/← = Back (`goBack()`). F/→ and Enter = open the row / press the control. H folds the legend. `exit` leaves. |
   | `projects`, `tabs`, `inside`, `section` | Q R X jump to the next tab asking / working / done, across every project the phone sees (`getActivity()` order, wrapping; Shift = previous). Backspace returns to the place before the last jump (depth 1). M C T open Mail / Calendar / To-do through `openSection`, doing nothing if the user hid that section. `/` goes to Home's search with the caret in it. |
   | `projects` | N = new project (desktop `newProject`). 1–9 open row N (desktop slot keys, AZERTY falls back by `code`), the desktop's project stations. |
   | `tabs` | N / + / = open the + FAB (desktop `newShell` + `newTabMenu`). W = close the tab after an engine-owned `ConfirmSheet`: the desktop confirms, and a single letter is easy to hit. `.` / ContextMenu = the card's ⋯. |
   | `inside` | ↑/↓ scroll the chat or terminal by a third of its height (Shift: a page). F/→ = jump to the latest. S/← = back to the list. 1–9 answer the live question. The desktop `agentPrompt` key (I at HEAD) focuses the composer, unless it is `disabled` (a live question or a press hint): then the legend flashes that. |
   | `region` | ↑/↓ walk the sheet's controls. Enter/→ press. S/←/Esc (desktop `back`) close the sheet through `goBack()`, since every sheet has a back layer. Y presses `[data-steer-confirm]` when one is present. `exit` is live here too, but without Escape (Esc is `back`). |
   | `section` | Like `region`, over the section's `main.screen`. Back steps out the way Back does. |

   Row-local acts work through markers, not new props: `data-steer-act="new" | "close" | "menu"`
   on existing buttons. A missing marker means the key does nothing. A status jump with no
   match shows a short message in the legend ("No tab waits on you"); nothing else pops up.

9. **Surfaces with their own keys pause steering.** While a `.files-library` or an
   `.outbox-viewer` is up (that includes `.markup-view`), every key passes through except
   the chords, and the legend reads "This view has its own keys". These surfaces already
   own arrows, `/` and Esc. The selector list lives in the engine, so those files, which
   have uncommitted edits on develop, are not touched. A source-scan test asserts the class
   names still exist. (Review clarification: a sheet opened *over* such a surface, for
   example `FilesLibrary`'s own `option-sheet`, is the top surface and is walked as
   `region`; the pause applies only when the surface itself is on top.)

10. **Legend.**
    - A bottom bar like the desktop's 28 px bar. It is fixed at `bottom: 0` above the safe
      area, uses a solid background (no `backdrop-filter`) and has no animation. Its
      `z-index` is above the sheet backdrop (`.sheet-backdrop` is 12; the tab bar is 8).
    - It shows a badge, the ladder, and the current level's most important keys in table
      order. Labels are i18n, keys come from `steeringKeyLabel`.
    - It wraps to at most two lines, and its height is a fixed two-line budget plus the
      safe-area inset (overflow hidden), so `--steer-bar-h` is a constant and nothing has to
      be measured.
    - `html[data-steer-bar]` sets `--steer-bar-h` and moves things clear of it:
      `.mobile-tabbar` sits above it; `.tabbed > .screen`, the `.tabbed > .todo-screen /
      .project-screen / .home-screen.has-fab` rule (style.css ~536, which overrides the
      first) and `.fab` move up; `.sheet-backdrop` gets bottom padding so a bottom sheet's
      last row is not under the bar; and `.terminal-screen` gets `padding-bottom` (the screen
      is `border-box`). A `height` calc would not work there: the screen's inline `height`
      from `viewportHeight` wins.
    - All of this lives in a new `mobile-web/src/steering/steering.css`. `style.css` is not
      edited, because it has uncommitted edits on develop.
    - Rows get a `scroll-margin-bottom`, so the cursor never hides under the bars.

11. **Strings and the untested register.**
    - Desktop i18n keys are reused where the wording fits: `steering.level.projects`,
      `steering.level.tabs`, `steering.exit.label`, `steering.nextDecision/nextWorking/nextDone.label`,
      `steering.mail/calendar/todo.label`, `steering.newProject.label`, `steering.menu.label`.
    - Everything else is new under `mobile.steering.*`, in all five dictionaries.
    - Untested rows (added with their pills in step 3, not earlier: the registry test fails
      on a row without a call site):
      - `mobile.steering.mode`
      - `mobile.steering.statusJump`
      - `mobile.steering.answer`
      - `mobile.steering.composer`
      - `mobile.steering.region`
      - `mobile.steering.tip`
    - Pills use the phone's `<span className="untested">` pattern, beside the matching legend
      key or in the tip.

12. **No backend change.** Nothing in `src-tauri/` is touched, so `backend:stale` is not
    needed. The phone bundle is rebuilt with `npm run mobile:bundle`.

## Open questions for the user (answered 2026-11-09)

**User's answers:** 1 → (A) phone-natural arrows; 2 → (A) one-time tip; 3 → (A) M C T + the `section` cursor. Build all three as written; they are now fixed decisions.

1. **Arrow directions on the phone's vertical lists.**
   - **(A) Recommended: phone-natural.** E/D (↑/↓) walk the rows, F/→ or Enter opens, S/←
     goes back. Phone lists run vertically and screens slide in from the right. E S D F
     stay the arrows, only the hierarchy turns 90°.
   - **(B) Desktop-literal.** S/F walk siblings, D goes in, E goes out. Muscle memory
     carries over, but ↓ no longer moves down a visible list.

   This plan is written for (A). (B) changes only the table rows and the legend
   (implementer 1).
2. **A one-time "keyboard connected" tip.**
   - **(A) Recommended.** The first hardware keydown on a device shows a small static hint
     for about 8 s or until the next key: "Keyboard connected — Shift+Space steers with
     E S D F". It never shows again and touch-only users never see it.
   - **(B) None.** Only the help page tells.
3. **Mail, Calendar, To-do and Tabby in v1.**
   - **(A) Recommended.** M C T open them, and the generic `section` walk moves a cursor
     over their controls (Enter press, ← back).
   - **(B)** M C T open them, and inside them the keyboard is plain Tab focus until a later
     round.

## Engine rules (added in review)

These make the fixed decisions precise against the real browsers and the real code. The
steps below use them.

1. **Match by `code` and `key`, never by `key` alone.** `isSpace(e)` is
   `e.code === "Space" || e.key === " " || e.key === "\u00a0"`. macOS-layout iPad keyboards
   type a no-break space under Alt, so `key` alone misses Alt+Space; some Android IMEs send
   an empty `code`, so `code` alone misses those. The existing phone tests fire keys with
   no `code`, so `key` must keep working. Shift+Space is `isSpace && shiftKey && !altKey`;
   Alt+Space is `isSpace && altKey && !shiftKey`. Digits keep the desktop's `Digit1` /
   `Numpad1` fallback (AZERTY).
2. **Any other Alt combination is ignored by the engine** (Alt+arrow is the browser's
   history; Alt+letter types special characters on iOS and macOS layouts). So no `code`
   fallback for letters is needed. Shift is not a modifier to the table (Shift+Q is Q
   backwards); `normalizeKey` lowercases, so Caps Lock is harmless.
3. **`e.repeat`.** Both chords ignore it (holding Shift+Space must not flicker the mode).
   Only move up/down and scroll accept it. Open, press, close, jumps, Enter and the digits
   ignore it, so a held key cannot open ten tabs.
4. **A key the table does not resolve is untouched**: not prevented, not stopped. That
   keeps Tab (and with it `useModalFocus`'s trap), F-keys and browser shortcuts working in
   the mode.
5. **Keyup.** The engine keeps a set of `code`s (else `key`s) whose keydown it prevented,
   and prevents the matching keyup whether or not the mode is still on. That covers the
   exit chord: its Space keyup arrives after the mode is off, and would otherwise click the
   focused button. The set is cleared on `blur` of the window.
6. **Typing targets** are `textarea`, `select`, `[contenteditable]` and an `input` whose
   type is text-like (not `button`, `checkbox`, `radio`, `range`, `file`, `color`,
   `image`, `reset`, `submit`). The event target may be `window` or `document` (tests
   fire there), so `isTypingTarget` takes `EventTarget | null` and tests
   `document.activeElement` as well. While the mode is on and a typing target has focus
   (steering put it there, or a sheet's `autoFocus` did), only Esc and the chords are
   acted on; Esc blurs the field and steering resumes with cursor repair (rule 7).
7. **Cursor repair.** The engine remembers the id of the last row it focused
   (`data-steer-row`). While the mode is on, a `MutationObserver` on `document.body`
   (`childList`, `subtree`, coalesced in one `requestAnimationFrame`) refocuses that id
   when `document.activeElement` is `body` (or null), no typing target and no modal is up,
   and the row exists. Otherwise it focuses the first row. It also runs after a level
   change. This covers: Home/Project remounting with their lists after a Back (the data
   loads late), a 5 s poll that reorders cards (moving a focused node blurs it in
   some browsers), and a closed sheet whose opener (the ⋯ button, the FAB) is not a row.
   When the focused element is inside a card that holds a `[data-steer-row]`, D/E walk
   from that card's row. The observer stops with the mode.
8. **Rows are visible when** they are connected, not `disabled`, and not inside
   `[hidden]`, `[inert]` or `[aria-hidden="true"]`, and `el.checkVisibility?.() ?? true`.
   No layout call: jsdom has none, and the old targets (Safari 14) lack `checkVisibility`.
9. **Scroll** writes `el.scrollTop` (jsdom has no element `scrollBy`; no smooth
   behaviour). A step is `max(48, clientHeight / 3)` and a page `max(96, 0.9 * clientHeight)`
   so a layout-less test still moves. The target is `[data-steer-scroll]`, else the
   `.xterm-viewport` of the visible terminal. `toLatest()` sets `scrollTop` to
   `scrollHeight`. `scrollIntoView` is called as `el.scrollIntoView?.({ block: "nearest" })`.
10. **Top surface.** `topModal()` is the last connected `[aria-modal="true"]` not inside
    `[inert]`. A paned (tablet) `FilesLibrary` / viewer has `aria-modal="false"`, so the
    own-keys check is: a visible, non-inert `.files-library, .outbox-viewer` exists and
    `topModal()` is null, or is that surface or inside it. A different modal on top means
    `region`.
11. **Status jumps.** Candidates come from `getActivity()` in list order, skipping tabs
    that are not `available`. `question` and `interrupted` are the "asks" kind (the phone's
    Waiting tile counts both), `working` is working, and "done" is `isUnseenDone(
    readSeenDone(), tab)` (what `NeedsYou` lists), not every finished tab. The walk
    continues from the open tab (`place` of a terminal) or from the first/last. Opening
    uses the App's `openTerminal`, so the list scroll is remembered as for a tap.
12. **Find request.** `/` leaves Home possibly unmounted (from a terminal or a section), so
    an event can be lost. `steeringState` holds a `findSeq` counter and
    `takeFindRequest()`; Home reads it in an effect on mount and when `findSeq` changes,
    and then does `choose("search")`. No window event.
13. **Close confirm.** `steeringState.confirm` holds the tab's id and label. Y / Enter in
    the sheet looks the card up by `[data-steer-row="<id>"]` at that moment and clicks its
    `[data-steer-act="close"]`; if the card is gone, it does nothing. `SteeringConfirm`
    renders inside the same `<BackNest>` as the screen, so its back layer sits on top of
    the screen's.
14. **Mounting.** `usePhoneSteering` is called near the other hooks in `App()`, before the
    `if (auth === ...) return` chain, with `enabled: auth === "paired"`. It reads its
    inputs through a ref, so the window listeners are added once per `enabled`. A render
    of `Terminal` or `Project` alone (the tests) has no engine; the tests mount the hook in
    a small harness component, or `<App />` where noted.

## Steps

Each step ends with the gates for what it touched green (`scripts/gates.sh`, in the
background) and `git diff --check`. Steps 1 and 2 add no visible feature on their own: the
engine is mounted but reachable only by the chord, and the bar arrives in step 3. That is
acceptable on a branch; the phone bundle is not rebuilt for the user until step 3.

### Step 1: shared key logic, phone table, state, DOM helpers, strings (implementer 1)

1. New `src/lib/shortcuts/keyNames.ts` with `MODIFIER_KEYS`, `normalizeKey` and
   `isLoneModifier`, moved out of `shortcuts.ts` (~lines 522–545; the old `MODIFIER_KEYS`
   const there is unexported and used only by `isLoneModifier`). `shortcuts.ts` imports
   them and re-exports `normalizeKey` / `isLoneModifier` (`export { … } from "./keyNames"`)
   because `chordFromEvent` and other callers use them; keep the hunk small, because
   develop has nearby uncommitted edits. `steeringBindings.ts` imports them from
   `./keyNames` instead of `./shortcuts` and turns `function keyMatches` into
   `export function keyMatches`. No table lines change, because develop's uncommitted
   edits are in the table. Run the `Shortcuts` and `Steering*` suites.
2. New `mobile-web/src/steering/phoneSteeringKeys.ts`. Pure; it imports only
   `steeringBindings`, `keyNames` and i18n types.
   - Types: `PhoneLevel = "projects" | "tabs" | "inside" | "section" | "region"`, a
     `PhoneSteeringAction` union, and
     `PhoneBindingDef { action; levels; desktop?: SteeringAction; keys?: readonly string[]; labelKey; group: "move" | "act" | "status" | "open" | "mode" }`.
   - `PHONE_STEERING_BINDINGS`, in resolution order, per decisions 4 and 8. `answer` and
     `openRow` reuse the desktop `slot1..9` keys. `exit`'s levels are all five, with
     Escape dropped from its keys on `region` (engine rule above).
   - Functions:
     - `phoneKeys(def, overrides)`
     - `phoneSteeringActionFor(e, level, overrides)`: characters first, then digits by
       `code`, as `steeringActionFor` does.
     - `phoneDigit(e, overrides)`
     - `findPhoneSteeringConflicts(overrides)`
     - `phoneRowKeys(def)`: the display text, built with `steeringKeyLabel`.
   - Chord and keyboard helpers, per the engine rules:
     - `isSpace(e)`, `isTypingTarget(target: EventTarget | null)`.
     - `isEntryChord(e, target)`: decision 5, including the empty-field rule and `repeat`.
     - `isIgnoredKey(e)`: Ctrl, Meta, Alt (except the Alt+Space chord), composing, 229,
       Unidentified, Process, Dead, lone modifiers.
     - `isHardwareKeydown(e, target)`: decision 7.
3. New `mobile-web/src/steering/steeringState.ts`. A module store in the phone's
   `useSyncExternalStore` style (no zustand in `mobile-web`), holding:
   - `active` and `legendFolded`;
   - `flash` (a TranslationKey plus vars, cleared after about 3 s);
   - `jumpBack: Place | null`, where `Place = { kind: "terminal"; project; tab: TabRow } | { kind: "list"; section: Tab; projectId: string | null }`;
   - `activity` (the last `ActivityTab[]` and when it was fetched);
   - `confirm` (`{ tabId; label } | null`, the W request);
   - `findSeq` and `takeFindRequest()` (engine rule 12);
   - the `inside` registry, defined here so steps 2 and 3 share it:
     `registerInside(target | null)` with
     `{ answer(n): "answered" | "freeText" | "none" | "missing"; focusComposer(): "focused" | "blocked"; hasQuestion(): boolean }`.
     Registering or clearing notifies subscribers (the bar shows the answer key from it).

   Plus `subscribe`, `getSteering`, `useSteering`, the setters, and `resetSteeringForTests`.
   While active, it sets and clears `html[data-steering]` and `html[data-steer-bar]` (the
   second only when the legend is not folded).
4. New `mobile-web/src/steering/steeringDom.ts` (DOM helpers, no React, none of them
   needs layout; see engine rules 7–10):
   - `topModal()`, `ownKeysUp()` with `OWN_KEYS_SELECTOR = ".files-library, .outbox-viewer"`
     (the markup view carries `outbox-viewer`).
   - `rows(root)`, `walk(list, dir, from)` and `focusRow(el)`: focus with
     `preventScroll`, then `el.scrollIntoView?.({ block: "nearest" })`.
   - `controls(modal)`: `focusables` from `modalFocus.ts` (export it there; it is
     currently a private function) filtered by rule 8, for `region` and `section`.
   - `press(el)`: `.click()`; a text field takes the caret instead.
   - `rowAct(rowId, act)`: the card is `closest(".tab-card, .home-project-card")`, then
     `[data-steer-act=…]`. `screenAct(act)`.
   - `scrollStep(dir, page)` and `toLatest()` (rule 9).
5. New `mobile-web/src/steering/phoneStatusJump.ts` (pure; named to avoid the desktop's
   `src/lib/shortcuts/statusJump.ts`, which imports stores): `kindOf(tab)` and
   `nextStatusTab(list, currentTabId, kind, backwards)` per rule 11.
6. **i18n, all five dictionaries.** This step adds **every** new key, so that later steps
   only use them. Place them in a `mobile.steering.*` block after the existing
   `mobile.status.*` keys, never at the end of the file (develop has uncommitted edits
   there). Check that nothing named `mobile.steering` exists yet (none does). English:

   | Key | English |
   |---|---|
   | `badge` | "Steering" |
   | `level.inside` | "Inside the tab" |
   | `level.sheet` | "Sheet" |
   | `key.move` | "Move" |
   | `key.open` | "Open" |
   | `key.back` | "Back" |
   | `key.scroll` | "Scroll" |
   | `key.latest` | "Latest" |
   | `key.answer` | "Answer" |
   | `key.type` | "Type to the agent" |
   | `key.new` | "New" |
   | `key.close` | "Close" |
   | `key.search` | "Find project" |
   | `key.jumpBack` | "Jump back" |
   | `key.confirm` | "Yes" |
   | `key.legend` | "Keys" |
   | `paused` | "This view has its own keys" |
   | `handoff` | "Typing — Enter sends, Esc back to steering" |
   | `handoffField` | "Typing — Esc back to steering" |
   | `none.decision` | "No tab waits on you" |
   | `none.working` | "No tab is working" |
   | `none.done` | "No tab is done" |
   | `noQuestion` | "No question on screen" |
   | `noOption` | "No option {n}" |
   | `blocked` | "The agent is waiting on a choice" |
   | `closeConfirm.title` | "Close {label}?" |
   | `closeConfirm.action` | "Close tab" |
   | `tip` | "Keyboard connected — {chord} steers with {keys}" |
   | `folded` | "Steering — H shows the keys" |

   Keep the existing tone, never spell the app's name, and translate de/es/fr/it. Every
   `{placeholder}` must survive in each language. The chord and key text in `tip` come in
   as `{chord}` / `{keys}`, never in the translation.
7. **Test helper** `src/__tests__/helpers/mobileSteering.ts`, used by every steering test:
   - `keyInit(key, mods?)` returns `{ key, code, shiftKey, … }` with the right `code`
     (letters `KeyX`, digits `DigitN`, `" "` → `Space`, the named keys as they are);
   - `press(target, key, mods?)` fires keydown then keyup on `target` (default `window`) and
     returns whether the keydown was `defaultPrevented`;
   - `stubLayout()` defines `Element.prototype.scrollIntoView` as a `vi.fn()` and restores it;
   - `resetSteering()` calls `resetSteeringForTests`, `resetBackStackForTests` and removes
     `data-steering` / `data-steer-bar` from `document.documentElement`.
8. **Tests**:
   - `src/__tests__/mobile/MobileSteeringKeys.test.ts`:
     - resolution per level;
     - shared rows equal `steeringKeys(desktop, null)`;
     - `findPhoneSteeringConflicts(null)` is empty on every level;
     - AZERTY digit by `code`;
     - entry chord cases: body, empty field, non-empty field, Alt+Space in a field,
       Alt+Space whose `key` is `"\u00a0"`, Ctrl/Meta+Space ignored, Shift+Alt+Space
       ignored, `repeat` ignored, composing/229 ignored, a lone Shift ignored;
     - hardware detection cases.
   - `src/__tests__/mobile/MobileSteeringImports.test.ts`: walk the relative imports from
     `mobile-web/src/steering/*.ts` recursively; fail on `@tauri-apps` or `src/stores`.
     Resolve `./x` to `x.ts` / `x.tsx` / `x/index.ts`; read with `node:fs` under the
     `@ts-expect-error` line; join paths per component (CI runs it on Windows too).
   - `src/__tests__/mobile/MobileSteeringDom.test.tsx`: `rows` (skips disabled, hidden,
     inert), `walk` wrap, `focusRow` focuses and calls the stubbed `scrollIntoView`,
     `topModal`, `ownKeysUp` (library on top vs a sheet over it), `controls`,
     `scrollStep` moves `scrollTop` with `clientHeight` 0.
   - `src/__tests__/mobile/MobileSteeringStatusJump.test.ts`: `kindOf`, `nextStatusTab`
     (wrap, Shift, nothing found, unavailable skipped, seen-done excluded).
   - The existing `src/__tests__/shell/SteeringBindings.test.ts` and `Shortcuts.test.ts`
     still pass unchanged.
9. **Filemap rows** (`docs/filemap_frontend.md`): `keyNames.ts`, and one combined row for
   `mobile-web/src/steering/` (its later files are added by steps 2 and 3). Extend the
   `modalFocus.ts` row (line ~43) by a clause.

### Step 2: the engine, the list levels and the sheets (implementer 2)

1. New `mobile-web/src/steering/usePhoneSteering.ts`, called once in `App()` (rule 14).
   - Input: `{ enabled, base: "projects" | "tabs" | "inside" | "section", sectionLabel, place: Place, openTab(projectId, row), openSection(tab), restore(place), findProject() }`.
   - It adds a window keydown and keyup listener in the capture phase, a capture
     `pointerdown` listener and a `visibilitychange` listener that exit the mode, and the
     cursor-repair observer (rule 7) while the mode is on.
   - Order of checks:
     1. ignored keys (`isIgnoredKey`);
     2. the entry chord, which toggles; entering blurs a focused field and puts the cursor
        on the remembered row, else the first;
     3. if the mode is off, return;
     4. own-keys surface (rule 10): pass the key through;
     5. a typing target has focus (rule 6): pass everything except Esc, which blurs and
        resumes. After an Enter inside the composer has left it empty, blur it;
     6. otherwise resolve the level (a `topModal()` means `region`), run the table with
        rules 2–4, prevent the keydown it resolved, and dispatch.
   - Inside the tab it calls the `inside` registry from `steeringState`. Until step 3
     registers a target, `scrollStep` and `toLatest` work and digits flash `noQuestion`.
   - Status jumps fetch `getActivity()` once a key is pressed, unless the cached copy is
     under 2 s old. While the mode is on, a `useVisiblePoll` refreshes it every 5 s so the
     legend can show counts; it is gated on `enabled && active`. (`NeedsYou` and `Activity`
     run their own polls: a second one while steering is accepted, and cheap.)
   - W stores `{ tabId, label }` in `steeringState.confirm` (rule 13).
   - `/` calls `findProject()`, which sets `steeringState.findSeq` (rule 12) and shows
     Home (`setTerminal(null)`, `setTabby(null)`, `setTab("projects")`,
     `setProjectView({ kind: "home" })`). Home answers with `choose("search")`; the
     input's `autoFocus` gives the caret, which is a typing target (rule 6). On Esc the
     cursor goes to the first result.
2. New `mobile-web/src/steering/SteeringConfirm.tsx`: a `ConfirmSheet` driven by
   `steeringState.confirm`. `OptionSheet` gets `data-steer-confirm` on the button of the
   option whose key is `"confirm"` (that is `ConfirmSheet`'s only key); no new prop.
3. **`App.tsx`** (697 lines today):
   - compute `base` and `place` from `terminal` / `tabby` / `tab` / `projectView`;
   - call `usePhoneSteering` before the first early return; the hook list sits above
     `if (auth === "loading")`;
   - mount `<SteeringConfirm />` inside the tabbed branch's `<BackNest>` (the confirm only
     happens on `tabs`);
   - provide `restore` (sets `terminal`, `tab`, `projectView` and `tabby` back) and
     `findProject`;
   - hand the engine an `openSection` wrapper: it does nothing for a section in
     `hiddenSections`, and it first clears `terminal` and `tabby` (the existing
     `openSection` only sets `tab`, and a set `terminal` keeps the Terminal branch on
     screen, so M C T from `inside` would otherwise do nothing visible).

   About 40 lines; no reshaping of the screen code. `<SteeringBar />` is mounted by
   step 3 in the three returned branches (`terminal`, `tabby`, tabbed): a fragment around
   each, since the branches return early.
4. **Markers, attributes only**:
   - `Home.tsx`: `projectCard` gets `data-steer-row={project.id}`; the new-project button
     (`.new-tab`, ~358) gets `data-steer-act="new"`; the effect for rule 12.
   - `NeedsYou.tsx` (`.home-needs-row`) and `Activity.tsx` (`.activity-card`):
     `data-steer-row={tab.id}`.
   - `TabCard.tsx`: `.tab-card-open` (both card kinds) gets `data-steer-row={tab.id}`;
     `.tab-card-more` gets `data-steer-act="menu"`; `.tab-card-close` (both kinds) gets
     `data-steer-act="close"`.
   - `Project.tsx`: the FAB (~855) gets `data-steer-act="new"`.
5. **Guards**: `ProjectFiles.tsx:80` returns on `event.defaultPrevented`; `rowDrag.ts:131`
   (the grip's React `onKeyDown`) returns on `event.defaultPrevented`.
6. **Tests** (use the step 1 helper; `goBack` is async, so `waitFor`):
   - `src/__tests__/mobile/MobileSteeringLists.test.tsx`: render `Project` with the mocked
     `fetch`, as `MobileProjectScreen.test.tsx` does, plus a harness that mounts
     `usePhoneSteering({ enabled: true, base: "tabs", … })`. Check that:
     - Shift+Space activates;
     - D focuses the second `.tab-card-open`;
     - Enter calls the `terminal` prop with that row;
     - W opens the confirm and Y sends the close request;
     - Esc or the chord exits, and the exit chord's keyup does not click the focused row;
     - `pointerdown` exits;
     - a held key (`repeat`) does not open;
     - with the mode off, Shift+Space in a non-empty input and letters in the composer are
       not `defaultPrevented`;
     - cursor repair puts focus back on the row after the list re-renders in a new order;
     - a jump-back restore through a fake App (`restore` called with the saved place).
   - `src/__tests__/mobile/MobileSteeringRegion.test.tsx`:
     - an `OptionSheet` puts the engine in `region`;
     - ↓ moves focus and Enter picks;
     - ← calls the sheet's back layer (`waitFor`);
     - Esc closes the sheet and does not leave the mode;
     - an `.outbox-viewer` passes keys through, and a sheet over it is walked;
     - a field that took focus by itself (`NameSheet`) takes typing and Esc returns.
   - `src/__tests__/mobile/MobileKeydownGuards.test.ts`: a source scan that every
     `addEventListener("keydown"` in `mobile-web/src` (except `steering/` and the Tab-only
     `modalFocus.ts`) reads `defaultPrevented`, that `rowDrag.ts` does too, and that every
     `OWN_KEYS_SELECTOR` class exists in the sources.
   - The existing `MobileBackStack`, `MobileFilesLibraryViewer`, `MobileTerminalOutbox` and
     `MobileAppSession` suites still pass: with the mode off nothing changes.
7. **Filemap rows**: `usePhoneSteering`, `steeringDom`, `phoneStatusJump`,
   `SteeringConfirm`. Extend the `backStack` row by a clause.

### Step 3: inside a tab, the legend, docs (implementer 3)

1. `mobile-web/src/terminal/selectPrompt.ts`: add a pure
   `optionForDigit(prompt, n): SelectOption | null` with the desktop rule: the option
   printed with number n, else the nth row when no option is numbered.
2. New `mobile-web/src/screens/terminal/useTerminalSteering.ts`. It registers the `inside`
   target while the Terminal is mounted, and answers only while the Focus view shows the
   `QuestionList` (`view === "focus"`):
   - `answer(n)`:
     - no `liveQuestion` → "none";
     - `optionForDigit` finds nothing → "missing" (the flash reads `noOption`);
     - a free-text row (`freeTextRow(option)`) → click the button of the row at
       `prompt.options.indexOf(option)` in `.question-list` (`QuestionRows` opens its
       `autoFocus` textarea, which is a typing target, so steering hands off) → "freeText";
     - otherwise `answerQuestion(option)`. `answerQuestion` already ignores a second digit
       while the first is held (`questionHeld`).
   - `focusComposer()`: "blocked" when the textarea is `disabled` (`chatInputBlocked`),
     else focus it.
   - `hasQuestion()`.
3. **`Terminal.tsx`**, a few lines, because develop has uncommitted edits in this file:
   one `useTerminalSteering({...})` call and `data-steer-scroll` on `.readable-output`.
   The composer's send is not wrapped (step 2 blurs the field after Enter).
4. New `mobile-web/src/steering/SteeringBar.tsx`, mounted in the three branches of
   `App.tsx` (see step 2.3). It shows:
   - the badge and the ladder (the current level bold; Sheet or the section's name off the
     ladder);
   - the level's keys from `PHONE_STEERING_BINDINGS`, grouped and in table order:
     - Q R X with counts from `steeringState.activity`, listed only while some tab has
       that state, as on the desktop;
     - the answer key only while the `inside` registry's `hasQuestion()` holds;
   - the flash line; the paused and handoff texts; the folded form (H);
   - untested pills beside the mode badge, the status keys, the answer key, the type key
     and the region ladder entry (literal ids, `isUntested("mobile.steering.…")`).

   Use `role="status"` and `aria-live="polite"` for the flash only. Also the one-time tip
   (open question 2): a `hintSteering` `MobileFlag` in `prefs.ts` (one name added to the
   union and a line in its doc comment; the `hint*` family is cleared by Reset tips, so
   also add `writeFlag("hintSteering", false)` to `resetTips` in `HintMessage.tsx`), set on
   the first `isHardwareKeydown`. The tip is also silent while `readFlag("hintsOff")`.
5. **`src/lib/untested.ts`**: the six `mobile.steering.*` rows (area `mobile`), each with
   one line saying what to try (see Verification), on one line each in the register's exact
   row format (`scripts/untested.mjs` parses it by regexp). Run
   `node scripts/untested.mjs check` before committing.
6. New `mobile-web/src/steering/steering.css`, imported from `main.tsx` after `./style.css`
   and `./themes.css` (equal specificity, so import order decides), with the decision-10
   rules and the cursor outline (`#8c7df4`, the phone's accent hex, themed by the build).
   No `box-shadow` animation and no `backdrop-filter`. Add the file to `SHEETS` in
   `MobileAnimatedShadowBlur.test.ts`.
7. **Tests**:
   - `src/__tests__/mobile/MobileSteeringInside.test.tsx`:
     - `optionForDigit` cases;
     - render `Terminal` with a live question, extending the
       `MobileFocusQuestion.test.tsx` setup (it mocks `@xterm/xterm`) and mounting the
       step 2 harness hook: with steering active, "2" delivers option 2's keys and "9"
       flashes `noOption`; a free-text option opens its field and hands off;
     - the type key focuses the composer, "hello" lands in it (not prevented), Esc resumes
       steering, Enter sends and the composer is blurred; the type key flashes `blocked`
       while a question is live;
     - ↑/↓ change `scrollTop` of `.readable-output`.
   - `src/__tests__/mobile/MobileSteeringBar.test.tsx`:
     - the ladder and keys per level, with labels through i18n;
     - status keys hidden at a count of zero;
     - H folds;
     - the tip shows once (flag) and not when `hintsOff` is set.
8. **Docs**:
   - `docs/help/mobile.md`: a new "Steering with a keyboard" section after "Using it" (that
     section ends before "The agent's questions about your marks", ~line 230), with the
     chords, the table by level, and the paused views. Keep headings unique and the
     front matter intact: these files are embedded by `src-tauri/build.rs` and parsed by
     the `real_corpus_parses` test, so run `cargo test -p tabtivity --lib help_mcp` once
     (the running app's help changes only with the next backend build; that is expected).
   - `docs/help/keyboard.md`: one paragraph pointing to it (develop has uncommitted edits
     here).
   - `DOCUMENTATION.md`: one line at the steering section (`rg -n "steering"` finds ~1205
     and ~1285; the phone part is near the other `mobile-web` lines), edit that range only.
   - `docs/context/phone_steering.md`: a short rationale file (cursor is DOM focus, levels
     derived from App state and DOM, why Alt+Space, why the own-keys pause, why Ctrl/Meta
     are ignored). `docs/context/` has no index file; nothing else to update for it.
   - `todo/group-h-crossplatform.md`: append a new item after `31cf` (the next free
     `31c?` id; `rg -n '\*\*31c' todo/`) with a 🖐️ manual phone QA box (the Verification
     walk) and ✅/❌ Android and iOS pairs, as the Back-stack item at ~3868 has.
   - Filemap rows: `SteeringBar`, `useTerminalSteering`, `steering.css`.

## Verification

**Gates** (`scripts/gates.sh`, in the background): `npm run build` (tsc and the desktop,
mobile and web bundles), `npm test`, `npm run lint`, `scripts/brand-check.sh`,
`git diff --check`. No Rust source is touched, so the cargo gates do not run; the help
edit of step 3 needs `cargo test -p tabtivity --lib help_mcp` once (it parses the embedded
`docs/help` corpus). `node scripts/untested.mjs check` for the register. Tests:
- the new `src/__tests__/mobile/MobileSteering*.test.*` (Keys, Imports, Dom, StatusJump,
  Lists, Region, Inside, Bar) and `MobileKeydownGuards.test.ts`;
- the updated `MobileAnimatedShadowBlur.test.ts`;
- the unchanged desktop `SteeringBindings` / `Shortcuts` / `Steering*` suites;
- the i18n parity test.

**Manual walk.** Never start the app: the user runs it. After `npm run mobile:bundle` the
phone reloads the PWA. Use an Android phone in Chrome as an installed PWA and an
iPhone/iPad in Safari as a home-screen app, each with a Bluetooth keyboard.

1. **Touch only, no keyboard.** Nothing new is visible anywhere; tapping the composer and
   typing on the on-screen keyboard behaves as before (a leading space included).
2. **Keyboard tip.** Connect the keyboard and press any key on Home: the tip appears once
   and never again after a reload (open question 2).
3. **Home.**
   - Shift+Space shows the bar ("Steering · Projects") and an outline on the first
     Needs-you or project row.
   - E/D and ↑/↓ move it, and the list scrolls; the row never hides under the bars.
   - Digit 3 opens project 3.
   - Shift+Space again leaves; Alt+Space enters too.
4. **Project.**
   - Enter or F opens the project: the ladder reads "Projects › **Tabs**", the cursor is on
     the first tab card.
   - W: "Close <tab>?". Y closes it, Esc cancels with the cursor back on the card.
   - `.` opens the ⋯ sheet: the ladder shows Sheet, ↑/↓ walk it, Esc closes it.
   - N opens the + sheet.
   - S/← goes back to Home, with the cursor on the project just left.
5. **Inside.**
   - Open an agent tab: the ladder reads Inside; ↑/↓ scroll the chat, Shift+↓ a page, F
     jumps to the latest.
   - Ask the agent something that makes it ask a question (a permission prompt): "1"
     answers it, and a number with no option shows "No option N".
   - I (Space after the desktop rework lands) puts the caret in the composer: type a line,
     Enter sends it and the bar returns; type again, Esc keeps the draft and returns.
6. **Status jumps.**
   - With one tab waiting on you in another project, Q opens it from anywhere.
   - Backspace returns to where you were.
   - R and X do the same for working and done tabs; Shift+Q goes backwards.
   - With nothing waiting, the bar says "No tab waits on you".
7. **Sections.** M, C and T open Mail, Calendar and To-do; ↑/↓ walk their controls and Enter
   presses one (open question 3). `/` jumps to Home's search with the caret in it; Esc puts
   the cursor on the first result.
8. **Own-keys views.** Open a file viewer or Mark up: the bar says "This view has its own
   keys", ←/→ still step pictures, and Esc still closes the viewer.
9. **Typing safety.** With steering off, type in the composer: "Hello world" with a capital
   and spaces, an IME word (any CJK or Gboard composition), and Shift+Space mid-sentence.
   Nothing is eaten and nothing enters steering.
10. **Touch exits.** Tap the screen while steering: the bar disappears.
11. **Platform checks** (record the results in the todo item):
    - Shift+Space on a Samsung keyboard with the language switch on; Alt+Space still enters.
    - iOS: does a hardware Esc reach the page? If not, the chord toggle and S/← cover
      leaving. Does Shift+Space reach the page with nothing focused? Does Alt+Space on a
      macOS-layout keyboard (it types a no-break space) enter the mode?
    - Hold E: the cursor keeps moving. Hold Enter on a project row: it opens once.
    - Android: Esc does not also trigger the system Back.
    - Ctrl+Space and Cmd combos are left to the OS.
12. **Idle lock.** Leave the phone steering with keys only for longer than the idle lock
    interval: it does not lock while keys are pressed.

## Organisation

**Shape:** three Sonnet implementers **in series in the one worktree**
(`.claude/worktrees/mobile-steering`, branch `mobile-steering`), then one Opus reviewer.

**Why serial:**
- Step 2 builds on step 1's table, state, DOM helpers and strings.
- Step 3 fills the `inside` registry that step 1 defines and step 2 calls, and mounts into
  the same `App.tsx`.
- Serial work means no merges between implementers, and the hot files have a single owner.

Each implementer commits at the end of their step (gates for the touched area green,
`git diff --check`) and leaves a one-paragraph handoff in their final report. Commits run
the pre-commit privacy check and queue a background dev build (`post-commit`); leave
that alone (AGENTS.md). Do not push.

**Hot shared files and who edits them:**
- **i18n `en/de/es/fr/it.ts`:** implementer 1 only, all keys at once. Later steps that
  need a new string ask the main agent rather than editing the dictionaries mid-step.
- **`src/lib/untested.ts`:** implementer 3 only, all six rows, in the step that adds their
  pills (the registry test fails on an unused row).
- **`docs/filemap_frontend.md`:** each implementer adds the rows for their own files.
  This is safe because the steps run in series.
- **`mobile-web/src/App.tsx`:** implementer 2 (the hook, confirm, base level and place),
  then implementer 3 (`<SteeringBar />` in the three returned branches).
- **`Terminal.tsx`, `steeringBindings.ts`, `shortcuts.ts`, `prefs.ts`, `HintMessage.tsx`:**
  keep the hunks minimal (steps 1.1, 3.3, 3.4). The main checkout has uncommitted edits in
  the first three, and in `style.css`, which this plan does not touch.

**Landing note:**
- **Merging.** The main checkout's develop working tree has uncommitted edits by another
  session: the desktop steering rework (`steeringAnswer.ts`, `jumpBack`, Esc / Space /
  Enter defaults), `steeringBindings.ts`, `shortcuts.ts`, the i18n dictionaries,
  `untested.ts`, `docs/filemap_frontend.md`, `DOCUMENTATION.md`, `docs/help/keyboard.md`,
  `Terminal.tsx`, `style.css` and phone viewer files. Of the files this plan edits, these
  are dirty there; `App.tsx`, `Home.tsx`, `Project.tsx`, `TabCard.tsx`, `modalFocus.ts`,
  `prefs.ts`, `docs/help/mobile.md` and `todo/group-h-crossplatform.md` are clean. Land by
  commit and then a 3-way merge
  (`git merge-file`) of each such working-tree file onto the new blob, so neither side's
  edits are lost.
- **Once the desktop rework is committed:**
  - switch the phone's `jumpBack` row to `desktop: "jumpBack"`;
  - re-run `MobileSteeringKeys.test.ts`: its conflict check is the guard that the new
    desktop defaults do not collide on a phone level;
  - optionally point the desktop's `steeringAnswer.optionForDigit` at the phone's copy in
    `selectPrompt.ts`.

### Agent steps

Each step is about 1–1.5 days, with at most about 3 large files.

| Agent step | Plan sections | Files | Depends on |
|---|---|---|---|
| I1 Keys, state, DOM helpers, strings (Sonnet) | Decisions 3–5, 7, 8, 11 (strings); Engine rules; Step 1 | new `src/lib/shortcuts/keyNames.ts`; `src/lib/shortcuts/shortcuts.ts` (re-export only); `src/lib/shortcuts/steeringBindings.ts` (import + `export keyMatches`); new `mobile-web/src/steering/phoneSteeringKeys.ts`, `steeringState.ts`, `steeringDom.ts`, `phoneStatusJump.ts`; `mobile-web/src/modalFocus.ts` (export `focusables`); `src/lib/i18n/{en,de,es,fr,it}.ts`; new `src/__tests__/helpers/mobileSteering.ts`; tests `MobileSteeringKeys`, `MobileSteeringImports`, `MobileSteeringDom`, `MobileSteeringStatusJump`; filemap | none |
| I2 Engine, lists, sheets (Sonnet) | Decisions 1, 2, 5, 6, 8, 9; Engine rules; Step 2 | new `mobile-web/src/steering/usePhoneSteering.ts`, `SteeringConfirm.tsx`; `mobile-web/src/App.tsx`; attribute-only edits in `screens/Home.tsx`, `screens/Project.tsx`, `screens/Activity.tsx`, `components/TabCard.tsx`, `components/NeedsYou.tsx`, `components/OptionSheet.tsx`; guards in `components/ProjectFiles.tsx`, `rowDrag.ts`; tests `MobileSteeringLists`, `MobileSteeringRegion`, `MobileKeydownGuards`; filemap | I1 committed |
| I3 Inside a tab, legend, docs (Sonnet) | Decisions 7, 8 (inside), 10, 11 (pills); Step 3 | `mobile-web/src/terminal/selectPrompt.ts` (`optionForDigit`); new `mobile-web/src/screens/terminal/useTerminalSteering.ts`; `mobile-web/src/screens/Terminal.tsx` (a few lines); new `mobile-web/src/steering/SteeringBar.tsx`, `steering.css`; `mobile-web/src/main.tsx`, `prefs.ts` (flag), `components/HintMessage.tsx` (reset line), `App.tsx` (bar in three branches); `src/lib/untested.ts`; tests `MobileSteeringInside`, `MobileSteeringBar`, `MobileAnimatedShadowBlur` (sheet list); `docs/help/mobile.md`, `docs/help/keyboard.md`, `DOCUMENTATION.md`, `docs/context/phone_steering.md`, `todo/group-h-crossplatform.md`; filemap | I2 committed |
| R Review (Opus) | All | The whole `mobile-steering` diff against develop | I3 committed |

The **reviewer** runs `scripts/gates.sh` for the touched gates and reads the diff against
the fixed decisions. In particular they check that:
1. With the mode off, nothing calls `preventDefault` except the two chords, and no path
   calls `stopPropagation`.
2. Every `keydown` listener honors `defaultPrevented`.
3. No Tauri or store import reaches the phone bundle.
4. Back, sheets and `inert` still behave (`MobileBackStack`, `MobileFilesLibraryViewer`,
   `MobileTerminalOutbox`; there is no dedicated `useModalFocus` suite).
5. i18n parity holds, no app name is spelled in code (brand rule), and untested rows and
   pills are present.
6. The CSS has no animated blur.
7. The `Terminal.tsx` / `steeringBindings.ts` / `shortcuts.ts` hunks are minimal for the
   landing merge.

The reviewer fixes small findings in place and reports larger ones to the main agent.

## Later

- Honor `settings.steering_keys` on the phone: a bridge field (for example on
  `/api/v1/status`), passed as `overrides`. The table already takes it.
- `?` cheat-sheet sheet; the legend's full key list on a tap.
- Digits on the `tabs` level open a new agent N, as on the desktop (through `NewTabSheet`'s
  agent order). Digits with no parsed dialog but `agent_status === "question"` type the
  raw digit, as the desktop's `rawDigit` does.
- ←/→ across the tabs of a multi-question dialog (`questionTabs`, `onStep`); the Plan/Goal
  chips and `/clear` (the desktop's L, G, K) from steering.
- U: the Agents view (the phone's cockpit) as a key; ←/→ walking a two-column grid
  geometrically.
- Steering inside the files library and Mark up (today they pause steering in favour of
  their own keys).
- Desktop `steeringAnswer.ts` reuses the phone's `optionForDigit`.

## Plan review (2026-11-09)

Reviewed against the code in this worktree (develop `b3239822`). No fixed decision was
reversed; none is impossible. Decisions 5, 6, 9, 10 and 11 got clarifying clauses only.

**Confirmed as written:** the import-graph claim (moving `normalizeKey`, `isLoneModifier`
and `MODIFIER_KEYS` to `keyNames.ts` leaves `steeringBindings.ts` with one value import and
one type import, and also removes the `shortcuts.ts` ↔ `steeringBindings.ts` cycle); a file
outside `tsconfig.mobile.json`'s `include` is type-checked once the phone imports it;
`themeColors` covers any file under `mobile-web/src/`; five dictionaries and the parity
test; `docs/help/mobile.md` and `keyboard.md` exist; `todo/group-h-crossplatform.md` is the
phone's group; every selector, class and function the plan names exists (`.tab-card-open`,
`.home-needs-row`, `.activity-card`, `.readable-output`, `OptionSheet`, `ConfirmSheet`,
`useBackLayer`/`goBack`, `getActivity`, `useVisiblePoll`, `MobileFlag`, `selectPrompt.ts`,
`useLiveQuestion`, `QuestionList`, `answerQuestion`).

**Fixed, and why:**
1. `focusables` in `modalFocus.ts` is a private function and has no visibility or inert
   filter: step 1 exports it and adds a filtered `controls()`.
2. The untested-register test fails on a row without a call site, so the six rows moved
   from step 1 to step 3 with their pills.
3. The plan put the legend's `--steer-bar-h` on a measured or wrapping bar and shrank
   `.terminal-screen` with a `height` calc. The screen has an inline `height`
   (`viewportHeight`), `.sheet-backdrop` (z 12) would cover a bar at z 8, and
   `style.css` ~536 overrides the `.tabbed > .screen` padding. Fixed in decision 10.
4. Key correctness: `key` alone fails for Alt+Space on macOS-layout iPad keyboards
   (no-break space), so chords match by `code` or `key`; held keys (`repeat`) flickered
   the chord and could open many tabs; the exit chord's Space keyup would click the focused
   button (keyup is now suppressed from a set of swallowed keydowns, not from the mode);
   a sheet's `autoFocus` field (Home search, `NameSheet`, `NewProjectSheet`) would have
   had its typing eaten (the handoff is now derived from focus); Alt combinations and
   `Dead` keys are ignored; keys the table does not resolve (Tab) stay untouched.
5. `rowDrag.ts:131` is a React `onKeyDown`, not a listener; `FilesLibrary`'s own
   `option-sheet` sits over a `.files-library`, so the own-keys pause now yields to a
   sheet on top (engine rule 10).
6. App structure: `App()` returns early per branch, so the engine hook must be called
   before the early returns, `<SteeringBar />` needs three mount points, not one line, and
   `SteeringConfirm` must sit inside the screen's `<BackNest>` for its back layer to win.
   Opening a terminal unmounts Home/Project, so the remembered row is only reachable by
   the cursor-repair observer (rule 7); a lost window event for `/` became the
   `findSeq` request (rule 12). `openSection` alone does not leave a terminal, so M C T
   from `inside` needed a wrapper.
7. jsdom: no `scrollIntoView`, `scrollBy`, `checkVisibility` or layout (`clientHeight` 0),
   so the DOM helpers avoid layout calls and scroll by `scrollTop` with a minimum step. A
   shared test helper (`helpers/mobileSteering.ts`) and a stub for `scrollIntoView` were
   missing. `goBack()` is asynchronous (`history.back()`), so tests `waitFor`.
8. Smaller: `useLiveQuestion` is in `screens/terminal/`, not in `Terminal.tsx`; the FAB is
   at `Project.tsx` ~855, not ~505; "done" for X should be `isUnseenDone`, not every
   finished tab; the composer is `disabled` while a question is live (flash `blocked`,
   new key); the free-text row is found as the nth `li` of `.question-list`; the tip flag
   is named `hintSteering` and joins Reset tips and `hintsOff`; the phone's status-jump
   file is `phoneStatusJump.ts` (the desktop has a `statusJump.ts` that imports stores);
   `docs/help` is embedded by `src-tauri/build.rs`, so its edit needs the `help_mcp` test;
   a `docs/context/phone_steering.md` rationale file was missing; reviewer test names.
9. Step sizing: the old step 2 held the engine, DOM helpers, status jumps, confirm, App,
   seven markers, two guards and four tests. The DOM helpers and the pure status-jump file
   moved to step 1, the `inside` registry moved to `steeringState` (step 1). Step 3 lost the
   composer-send wrapper. The Agent steps table matches.

**Still risky:**
- Real-device behaviour of Shift+Space (Samsung, iOS with nothing focused), hardware Esc on
  Android (may act as system Back) and iOS, and Alt+Space on iPad. The plan has Alt+Space
  as the fallback and a manual walk; nothing here can be unit-tested.
- Cursor repair (rule 7) is the least certain piece: a `MutationObserver` that refocuses
  after a remount. Step 2 must test it, and keep it off while the mode is off.
- `Favorites` has no steering rows (no markers), so the cursor does nothing there; the
  search results and Agents list do work. Acceptable for v1; say so in the help text.
- `Terminal.tsx`, `steeringBindings.ts`, `shortcuts.ts`, i18n, `untested.ts`, filemap,
  `DOCUMENTATION.md` and `keyboard.md` are dirty in the main checkout: the landing merge is
  manual.
- The engine's 5 s activity poll duplicates `NeedsYou` / `Activity` polls while steering
  is on. Acceptable; share the result later if it shows.

---

## Critical files for implementation

- `src/lib/shortcuts/steeringBindings.ts`
- `mobile-web/src/App.tsx`
- `mobile-web/src/screens/Terminal.tsx`
- `mobile-web/src/modalFocus.ts`
- `mobile-web/src/components/TabCard.tsx`

Also relevant:
- `mobile-web/src/visiblePoll.ts`, `seenDone.ts`, `components/QuestionRows.tsx`, `components/OptionSheet.tsx`, `components/ConfirmSheet.tsx`
- `mobile-web/src/backStack.ts`
- `mobile-web/src/screens/terminal/useLiveQuestion.ts`
- `mobile-web/src/terminal/selectPrompt.ts`
- `mobile-web/src/api.ts` (`getActivity`)
- `src/lib/shortcuts/steeringAnswer.ts` (main checkout): uncommitted, main checkout only; read-only reference.
