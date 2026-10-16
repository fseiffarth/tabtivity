# React 19 — plan

**Status: plan only** (2026-10-14). Nothing installed, nothing committed.
Counts below were measured on develop `78c6bb4b` with `rg` over `src/` and
`mobile-web/src/`; re-measure on the install day.

## Why

The upgrade is worth doing for what it lets us delete, not for the version
number:

- **`useEffectEvent`** (React 19.2+) gives an effect the latest props/state
  without listing them as dependencies. Today that is hand-rolled: **293**
  `xRef.current = x;` "latest value" assignments in 59 files, **72**
  `eslint-disable … exhaustive-deps` comments in 39 files, and **28** live
  `exhaustive-deps` warnings. AGENTS.md tells agents not to add a dependency
  just to silence one, because it can restart a terminal or refetch on every
  render. `useEffectEvent` is the sanctioned way to drop a dependency, and
  hooks-plugin 7 knows it.
- **Error reporting with component stacks**: `createRoot(el, {
  onUncaughtError, onCaughtError })` hands `crashReporter.ts` React's
  `componentStack`. Today it sees only `window.onerror` (no stack into the
  tree), and `ViewerErrorBoundary` swallows what it catches.
- **Less ceremony**: `ref` is a plain prop (no `forwardRef`, 2 files), and a
  context renders as its own provider (`<Ctx value>`, 64 `.Provider` sites in
  24 files).
- **Staying current**: React 18 gets no feature work, and @types/react 18
  stops at 18.3.x. testing-library 16, zustand 5 and react-scan 0.5 already
  accept 19, so nothing else has to move.

## Fixed decisions

These are settled. A reviewer does not reopen them; doubts go under "Flagged
for user" in the handoff.

1. **Versions**: react, react-dom, @types/react and @types/react-dom at
   **19.3.0** (published 2026-09-09, past the 30-day major cooldown in
   `.github/dependabot.yml`). eslint-plugin-react-hooks at **7.1.1**
   (2026-04-17). Pin exact versions, no caret, as the vite 8 plan does. On the
   install day, recompute "newest version ≥ 30 days old" and take that.
2. **The lint rule set does not change in R1.** Plugin 7's
   `configs.recommended` adds the React Compiler rules (`refs`, `purity`,
   `immutability`, `set-state-in-effect`, …) at error level. Replace the
   `...reactHooks.configs.recommended.rules` spread in `eslint.config.js` with
   an explicit list: `rules-of-hooks: 'error'`, `exhaustive-deps: 'warn'`.
   Count what the compiler rules would report (run once with them on) and put
   that count in the handoff. Turning them on is a separate decision for the
   user.
3. **eslint stays on 9.** Plugin 7 supports eslint 9 and 10; eslint 10 is its
   own bump.
4. **No React Compiler** (babel-plugin-react-compiler). It belongs after the
   vite 8 plan lands (plugin-react 6 changes how babel plugins attach), and it
   needs the compiler lint rules clean first.
5. **`useEffectEvent` is never passed down or called during render.** Per
   React's rules, only effects (or functions they call: listeners, timers and
   xterm/pdf.js callbacks registered inside them) may call it. A ref read in a
   JSX `onClick` is not a candidate. Neither is a ref that holds imperative
   state (an instance, a timer id, a "did X" flag) rather than the latest
   value.
6. **`<Activity>` never wraps `TerminalView` or `PdfViewer`.** A hidden
   Activity runs every effect's cleanup and re-runs it on show. For xterm that
   means dispose and rebuild, and for pdf.js it means re-render. Both
   deliberately keep their instances alive while hidden (renderer release
   after `RENDERER_RELEASE_MS`, the hidden-pages logic). Activity is a spike
   (R5), not a migration.
7. **One commit per step**, each green on every gate it touches. The terminal
   files go last and get the user's live check before landing (a dependency
   change there can restart a terminal).
8. **Lockfile procedure** per the dependency-bump notes: install with any npm,
   merge only the bumped packages' entries back into HEAD's
   `package-lock.json`, then check with `npx npm@11.21.0 ci --dry-run`. After
   landing from a worktree, swap the bumped package dirs into the main
   checkout's `node_modules` (the frozen dev build uses it), then run
   `git hook run post-commit`.

## Measured surface

| What breaks or changes in 19 | Sites | Fix |
|---|---|---|
| `useRef<T>()` with no argument (types now require one) | 6, in `TerminalReaderView.tsx:677` and `mobile-web/src/screens/Terminal.tsx` (836, 841, 956, 2067, 2068) | `useRef<T \| undefined>(undefined)` |
| Global `JSX` namespace removed from the types | 1, `AppShell.tsx:268` | `React.JSX.Element` |
| Legacy `ReactDOM.render`, `findDOMNode`, `defaultProps`, `propTypes`, string refs, `react-dom/test-utils` | 0 | none |
| `createRoot` call sites | 5: `bootstrap.tsx`, `mobile-web/src/main.tsx`, `terminalPreview.tsx`, `web/WebShell.tsx`, `mountPageStrip.tsx` | none in R1; R2 adds the error options to the first two |
| Ref callbacks that implicitly return a value (now a type error: a return is read as a cleanup) | `tsc` reports them; none found by `rg` | wrap the body in braces |
| `ReactElement["props"]` is `unknown` | `tsc` reports them | type the element |
| StrictMode differences (both roots use StrictMode): ref callbacks run twice on mount; `useMemo`/`useCallback` reuse the first render's result in the double render | tests and dev only | fix any test that counted calls |
| Errors caught by a boundary are no longer re-thrown (go to `console.error`); uncaught ones go through `window.reportError` | `crashReporter.ts`, the 2 `componentDidCatch` boundaries | R1: check that `window.onerror` still fires for an uncaught render error; R2 improves it |

Test suite: 825 test files. 360 import `@testing-library/react`, whose 16.x
accepts 19. One file imports `act` from `react` (`ShortcutHint.test.ts`),
which is the 19-correct import.

## Steps

### R1 — bump, types, lint (one commit)

- `package.json`/lock: react, react-dom, @types/react, @types/react-dom at
  19.3.0; eslint-plugin-react-hooks at 7.1.1 (decision 1).
- `eslint.config.js`: explicit hooks rules (decision 2).
- Fix the type fallout from the table, plus whatever TS 7 `tsc` reports for
  both tsconfigs.
- Fix tests broken by StrictMode double-invocation or act timing. Don't
  loosen any assertion; add a comment where a count changes because of 19.
- **Real-library tests** (the xterm 6 and pdf.js bumps each found latent bugs
  this way). Add tests that run real React 19 for:
  - an uncaught render error reaching `crashReporter`'s `error` listener;
  - `ViewerErrorBoundary` catching and showing its fallback;
  - a portaled dialog keeping its explicit `color` and closing on Escape;
  - a zustand store read through `useSyncExternalStore` updating one
    subscriber without re-rendering a sibling.
- Gates: `npm run build` (tsc TS 7 + the desktop, mobile and web bundles),
  `npm test` with the **test count** compared to baseline, and `npm run lint`
  with no new warnings (28 `exhaustive-deps` at baseline).

### R2 — root error hooks (one commit)

- `src/bootstrap.tsx`: `createRoot(root, { onUncaughtError, onCaughtError,
  onRecoverableError })`, each feeding `crashReporter.report` with the error's
  stack plus `errorInfo.componentStack`. This needs a new exported entry in
  `crashReporter.ts`, deduped and capped like the existing one. Keep the
  `window` listeners for non-React errors.
- `mobile-web/src/main.tsx`: the same, but only if the phone already reports
  errors somewhere. If it doesn't, leave it alone (no new reporting path).
- Tests: a thrown render error lands in one report with a component stack,
  and a caught one is reported once, not twice.

### R3 — mechanical modernisation (one commit, no behaviour change)

- `forwardRef` → `ref` prop: `PromptDraftBoard.tsx`, `PasswordInput.tsx`.
- `<X.Provider value>` → `<X value>` across the 24 files.
- The existing tests must pass unchanged. No other edits in this commit.

### R4 — `useEffectEvent`, in waves (one commit per wave)

A **candidate** is a ref whose only job is to let an effect, or a listener or
timer the effect registered, read the latest prop, state or callback. It gets
`const onX = useEffectEvent(...)`, the ref and its assignment are deleted, and
any `exhaustive-deps` disable that existed only for it is removed.
Everything else stays (decision 5).

- **R4a — lint-disable sites.** The 72 disable comments and 28 live warnings,
  file by file, outside the files in R4b–R4d. Acceptance: each removed
  disable is a candidate, and the warning count only goes down.
- **R4b — viewers.** `FileViewerPane.tsx` (31 latest-refs), `DeckView.tsx`
  (14), `GifView.tsx` (10), `ImageAnnotator.tsx` (9), `PresentationOverlay.tsx`
  (7), `PdfPresentApp.tsx` (7), `MachinesIndicator.tsx` (9).
- **R4c — PDF and markup.** `PdfViewer.tsx` (28), `usePdfMarkup.ts` (12),
  `mobile-web/src/components/MarkupView.tsx` (23). The hidden-pane tests
  (`PdfSleepHidden`, `PdfHiddenPages`, `PdfCostRegistry`) must stay green
  untouched.
- **R4d — terminals, last.** `TerminalView.tsx` (22) and
  `mobile-web/src/screens/Terminal.tsx` (15). Every effect's dependency list
  must stay identical or shrink, never grow. Add a test per file proving that
  a prop change which used to flow through a ref neither re-creates the xterm
  instance nor restarts the session. This wave needs the user's live check
  before landing.

Each wave's handoff records: refs removed, disables removed, the warning
count, and any candidate left alone with the reason.

### R5 — `<Activity>` spike (no commit unless the user approves)

In a worktree, wrap one light viewer whose hidden-pane gating only pauses
work (the `OdtView` or `GifView` path through `PaneVisibleContext`) in
`<Activity mode={visible ? "visible" : "hidden"}>` and drop its manual
gating. Measure with the dev perf monitor: idle CPU while hidden, show
latency, scroll position kept. Report whether it saves code without costing a
rebuild on show. `usePoll` and the 50 `PaneVisibleContext` sites stay as they
are unless the spike wins clearly and the user agrees.

## Order with the other frontend plans

This plan is independent of `docs/done/vite8_vitest5_migration_plan.md`
(plugin-react 4.7 and vitest 4 both run React 19), but both edit
`package.json` and the lockfile. Don't run them at the same time: land
whichever starts first, then rebase the other onto it. The React Compiler
(decision 4) waits for both.

## Verification the user does (never run by an agent)

After R1 and R3, in the frozen dev build:

1. Open a terminal tab and an agent tab. Type, resize the window, switch
   away for a minute, and switch back: the content is intact and the session
   was not restarted.
2. Open a PDF, a deck and an image. Hide each behind another tab, then show
   it again: the scroll position and zoom are kept.
3. Open a menu, a dialog and a confirm prompt. Check text colour, Escape,
   and click-outside.
4. Pop a viewer out into its own window and edit something there.
5. On the phone PWA: the terminal, the Focus chat, and PDF markup.

After R4d: repeat step 1 with two agent tabs mid-turn.
