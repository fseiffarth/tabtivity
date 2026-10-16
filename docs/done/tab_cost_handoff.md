# Tab cost plan — handoff

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Plan: `docs/done/tab_cost_plan.md`. Branch `perf` (worktree
`.claude/worktrees/perf`). Nothing here was run live.

Status: T1–T3 implemented + reviewed, final review done 2026-10-10. Not
landed on `develop`, not run live.

## T1 (implementer)

**Commit:** `79c9080a` — Show what each tab holds and warn when many PDFs are
loaded (plan step 1). Base `3b5fd7a4`.

**What landed**
- `src/lib/tabCost.ts`: PDF registry (`registerPdfDoc` / `updatePdfDoc` /
  `unregisterPdfDoc`, `loadedPdfCount`, `subscribeLoadedPdfCount`,
  `pdfCostFor`, `untabbedPdfCost`), `terminalCost`, `tabCost`, `rankTabCosts`,
  `costBytes`, `describeTabCost`, `pdfWarnStep` + `PDF_LOADED_WARN_AT` (8),
  `PDF_LOADED_REARM_AT` (5), `PDF_WARN_GRACE_MS` (2 min), `_clearTabCostForTest`.
- `PdfViewer.tsx` `PdfCanvas`: two hunks — register/unregister in the unmount
  effect, one effect reporting pages/bytes.
- `TabHoverCard.tsx` memory row (pill `tabCost.hover`); `TabCostList.tsx` in
  Settings → Power & performance after the sleep-tabs row, main window only
  (pill `settings.tabCosts`, search key added); `PdfLoadWarningHost.tsx`
  mounted in `AppShell` beside the toasts.
- i18n keys in all five files, two `untested.ts` rows, filemap rows
  (`tabCost.ts`, `TabCostList.tsx`, `PdfLoadWarningHost.tsx`, clause on
  `PdfViewer.tsx`), QA row 2415 in `todo/group-u-performance.md`.

**Choices made (where the plan left room or was off against the code)**
- Registry token = the canvas's `PdfWorkerSlot` (already created in the
  unmount effect, so "same token" holds). `tabKey`/`path` reach the mount-only
  effect through a ref (`costMeta`) so no exhaustive-deps warning is added.
- The update effect keys on `[sources, docBytes, doc, tabKey, path]`, not just
  `[sources, docBytes]`: `doc` null (file switch in flight, failed load) reports
  0 pages, so a failed load whose old sources were already freed is not counted;
  `tabKey`/`path` keep the entry's identity current.
- Bytes = `docBytes` for `SELF` + `bytes.byteLength` of any non-`SELF` source.
- Terminal "rows of cap": rows = scrollback rows in use
  (`buffer.normal.length − term.rows`, clamped to the cap), cap =
  `options.scrollback`, so it never reads "2,040 of 2,000". The estimate uses
  the full buffer length.
- `tabCost` order: PTY kinds → terminal; else a registry entry → PDF line (or
  none while loading); else a `pdf`/`texworkspace` embed tab → `elsewhere` if a
  popout shows it (main window only), otherwise `unloaded`. A popped-out PDF
  whose main copy is held (sleep = Never) has an entry and shows its size.
- List rows: tab label + the same text as the hover row; "others" counts tabs
  with a line but no estimate (asleep, unbuilt, unloaded, elsewhere) — kinds
  with no line at all (calendar, …) are not counted.
- Hover label is lowercase "memory" (de "Speicher"), matching the card's
  existing "activity"/"session" labels; the plan wrote "Memory".
- Toast text names the real section, "Settings › Power & performance" (the
  plan's "Settings › Performance" is not the page's label).
- `TabCostList` gets a `tab-cost-list` class on its card (hook only, no CSS).

**Gotchas**
- Vitest fake timers replace `performance`: call `vi.useFakeTimers()` before
  `vi.spyOn(performance, "now")`, or the spy is overwritten
  (`PdfLoadWarningHost.test.tsx`).
- The registry is per window; `PdfLoadWarningHost` is mounted only in
  `AppShell`, so popouts never toast.

**Gates** (all in the worktree, after the change)
- `npm run build`: ok (tsc + both bundles).
- `npm test -- --reporter=dot`: 770 files / 7787 tests, all pass (baseline
  765 / 7765; +5 files, +22 tests).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`: ok.
- No Rust touched; cargo gates not needed. Acceptance: `rg setInterval` over
  the three new files = 0; `TerminalView.tsx` and `terminalBus.ts` untouched.

**Flagged for user**
- Not run live. QA row 2415 (T1.1–T1.3) is the manual check.
- The hover row's "N of M lines" shows today's cap (5,000) until T2 lands.
- Threshold 8 / re-arm 5 / grace 2 min are constants (plan's open question).
- The toast shares `conn-toast`'s position; a connection toast at the same
  moment would overlap it (same as the existing switch/conn pair).

## T1 (reviewer)

Range reviewed: `3b5fd7a4..71efaa06`. Bugs only; nothing run live.

**Fixes**

| Commit | Bug | Test |
|---|---|---|
| `35cbee11` | Close in the Settings list re-read the registry inside the click handler, before React unmounted the closed tab's `PdfCanvas`: its document stayed in "PDFs loaded now" and showed up as a PDF outside a tab until the next Refresh. The re-read now runs in an effect after the commit (passive unmount cleanups run first). | `TabCostList.test.tsx` "re-reads once the closed tab's viewer has unmounted, not before" (fake canvases that unregister on unmount, as the real one does) |
| `4c083d49` | The loaded-PDF toast carried only `conn-toast`'s placement, so it sat exactly on a connection toast shown at the same moment (a project switch that loads PDFs), and its two lines reached into a remote project's two-line switch toast. It now takes the next slot down (`.conn-toast.pdf-warn-toast { top: calc(50% + 108px) }`), the offset-sibling rule `conn-toast` already uses below the switch toast. | `PdfLoadWarningHost.test.tsx` "sits in its own slot below the connection toast" (class on the toast + the rule in the CSS corpus, below `.conn-toast`) |

**Checked, no bug:** registry register/unregister ordering incl. StrictMode
(the update effect runs after the register effect and reads the new slot);
§4.3 release and pane sleep unmount `PdfCanvas` → entry gone; failed load /
file switch → `doc` null → 0 pages, not counted; per-window registries (popout,
presenter windows never mount `AppShell`); TeX `<tab>#<path>` panes sum under
the tab and are not "outside a tab"; no reading renders as 0 B (a loaded entry
always has `docBytes`; terminals only print a size when live); hysteresis
(8 / re-arm 5 / grace, StrictMode re-subscribe keeps the ref); Show/Close use
the row's scope; hover card is the existing portaled card's classes; i18n keys
and placeholders in all five files; both untested ids rendered as pills.

**Gates** (worktree, after the fixes)
- `npm run build`: ok.
- `npm test -- --reporter=dot`: 770 files / 7789 tests, all pass (+2 tests).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `scripts/brand-check.sh`, `scripts/privacy-check.sh` (staged and
  `71efaa06..HEAD`), `git diff --check`: ok. No Rust touched.

**Flagged for user**
- A crossing of 8 inside the 2-min grace fires only on the next count change
  after it; a restore that stays at ≥ 8 with no further change never toasts
  (as the plan specifies — say if it should check once when the grace ends).
- "N more tabs hold nothing loaded" also counts asleep terminals (their program
  runs) and popped-out tabs (they hold memory in the popout) — wording, not
  a count error.
- "{n} PDFs open outside a tab" reads "1 PDFs" for one (no plural forms in the
  keys); same for "{n} more tabs".
- A TeX workspace tab that has never shown its PDF pane reads "Unloaded —
  reloads when shown" though it never loaded one (plan's rule for `texworkspace`).
- New toast slot position (`+108px`) is computed from the CSS, not seen live:
  QA row 2415 should glance at a project switch that lands on ≥ 8 PDFs.

## T2 (implementer)

**Commits** (base `8906ccc4`)
- `5501a9da` — T1 leftovers: the loaded-PDF notice looks once when the
  start-up grace ends; singular forms for the cost list/readout.
- `a5ef5292` — Shell scrollback setting (plan step 2).

**T1 leftovers**
- Grace end: `pdfWarnGraceLeft(nowMs)` in `tabCost.ts` (ms left, or null
  once over). `PdfLoadWarningHost` sets one `setTimeout` for that long at
  mount (none in a window older than the grace), which runs the same
  `pdfWarnStep` on `loadedPdfCount()`; cleared on unmount. A crossing already
  warned is disarmed, so no double notice. Tests: three new cases in
  `PdfLoadWarningHost.test.tsx` (shows once at grace end on an unmoved
  crossing; quiet if the count fell below 8; no timer when past the grace),
  plus `pdfWarnGraceLeft` in `TabCost.test.ts`.
- Plurals: the codebase's pattern is a separate `…One` key picked with
  `n === 1 ? "…One" : "…"` (no ICU). Added `settings.tabCostsOthersOne`,
  `settings.tabCostsUntabbedOne` and — a sibling of the same bug —
  `tabCost.pdfOne` ("1 page") in all five files. `TabCostList.test.tsx`
  assertions now expect "1 more tab holds…" / "1 PDF open…"; `TabCost.test.ts`
  checks "1 page" and that every dictionary has a distinct `One` form.

**T2 choices**
- `src/lib/terminal/scrollback.ts`: `SHELL_SCROLLBACK_DEFAULT` 2000,
  `SHELL_SCROLLBACK_CHOICES` [1000, 2000, 5000, 10000], `…_MIN`/`…_MAX`
  100/50000, `AGENT_SCROLLBACK_ROWS` 5000, `shellScrollbackRows` (non-finite →
  default, else floor + clamp), `scrollbackRowsFor(kind, setting)`.
- The shared kind helper is `terminalViewKind({ kind, cmd, env })` in
  `lib/terminal/terminalSpawn.ts` (beside the spawn identity, which already
  imports `stores/tabs`). `TerminalView` computes `paneKind` once at the top
  of the component; the spawn effect calls the same helper (it cannot read a
  render value without adding a dep). The old duplicated derivation at the
  render site is gone, as are the now-unused `cmdToKind`/`envName` imports.
- `TerminalView`: `scrollbackRowsRef` read in `buildTerm`; a separate
  `useEffect([scrollbackRows])` sets `termRef.current.options.scrollback`. Not
  in the spawn deps, not in `TerminalSpawnInputs`/`terminalSpawnKey`.
- Settings row after the sleep-tabs row, same `SettingRow` + `Dropdown`
  shape; value shown is the effective (clamped) cap, so a hand-edited value
  off the list shows unselected (as the sleep-tabs row does). Search key
  `settings.shellScrollback` added. Help text says agents keep 5,000 and a
  lower value drops open shells' oldest lines at once.
- Readout: `terminalCost` already reads `term.options.scrollback`, so "N of M
  lines" is the real cap now; `TerminalScrollback.test.tsx` pins it (2,000,
  then 1,000 after a live change). QA 2415 T1.1 text updated.
- Rust: `shell_scrollback_rows: Option<u32>` named field with
  `#[serde(default, skip_serializing_if)]` after `sleep_tabs_after_min`; test
  `shell_scrollback_rows_defaults_absent_and_round_trips` also parses an old
  settings JSON without the key.
- UntestedTag `settings.shellScrollback` + `untested.ts` row; filemap rows:
  `TerminalView.tsx` clause, `terminalSpawn.ts` clause, new
  `lib/terminal/scrollback.ts` row; QA row 2416 (T2.1, four platform pairs).

**Gotchas**
- The xterm mock in `TerminalSleepWake.test.tsx` ignores constructor options
  and has no `buffer.normal`; `TerminalScrollback.test.tsx` has its own mock
  that keeps `options` and gives `buffer.normal` so `terminalCost` works.
- `seq 1 5000` in a 2,000-line shell starts near 3000 minus the screen
  height: xterm keeps the viewport on top of the scrollback (QA text says so).

**Gates** (worktree, after `a5ef5292`)
- `npm run build`: ok.
- `npm test -- --reporter=dot`: 772 files / 7806 tests, all pass (baseline
  770 / 7789; part A +6 tests → 7795, part B +2 files / +11 tests).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `cargo test -q`: all pass (lib 3654 passed, 3 ignored). `cargo clippy
  --all-targets -D warnings`: clean. Windows `cargo check --target
  x86_64-pc-windows-msvc`: ok.
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`: ok.
- `npm run backend:stale`: the open window and its embedded phone bundle
  predate the current build (it is not running this branch). An older backend
  keeps `shell_scrollback_rows` in `Settings.extra`, so it round-trips; the
  setting itself is read entirely by the frontend.

**Flagged for user**
- Not run live. QA rows 2415 (updated) and 2416 are the manual checks.
- Lowering the setting trims open shells' history at once (by design, said in
  the help text); raising it does not bring trimmed lines back.
- Help text names "5,000" for agents as a literal in all five languages; if
  `AGENT_SCROLLBACK_ROWS` ever changes, the text must too.

## T2 (reviewer)

Range reviewed: `8906ccc4..c501ef4d`. Bugs only; nothing run live.

**Fixes**

| Commit | Bug | Test |
|---|---|---|
| `d30eec1e` | The grace-end one-shot could be lost for good: `setTimeout` truncates the fractional `left` to whole ms and `performance.now()` is coarsened (sub-ms with jitter in WebView2), so the timer can fire on a reading just under `PDF_WARN_GRACE_MS`; `pdfWarnStep` then declines and nothing looks again on an unmoved count. The timer now rounds its delay up and reads the clock as at least the grace's end. | `PdfLoadWarningHost.test.tsx` "still looks when the grace-end timer fires on a clock reading just short of the grace" |
| `a1bd6236` | (implementer's flag) The help hard-coded the agents' "5,000" in five languages. Now `{n}`, filled from `AGENT_SCROLLBACK_ROWS.toLocaleString()` as the sibling `…Lines` label does. | `ShellScrollbackSetting.test.tsx`: every dictionary has `{n}` and no digit; the rendered Settings row reads the constant |

**Checked, no bug:** the scrollback is not in the spawn effect deps nor in
`TerminalSpawnInputs`/`terminalSpawnKey`, so a change cannot respawn, wake or
re-key a PTY (sleeping panes compare only the spawn key); the live effect is a
no-op before the S4 lazy build (`buildTerm` reads the ref) and an S10 wake
builds a fresh xterm from the ref; xterm 5.5 applies `options.scrollback` live
(`BufferSet` resizes on the option, `trimStart` fires `onTrim`); popouts
follow through `SETTINGS_CHANGED_EVENT`; there is one `new Terminal` in `src/`.
`terminalViewKind` equals both old copies for every real kind: all tab panes
pass `tab.kind` (root console, Host session, docked/overlay columns, remote,
container tabs all go through `TabPane`), dialogs' terminals pass none (→ by
command, `ssh` → shell). Clamp: 0/negative → 100, huge → 50,000, string/null/
NaN → 2,000. Rust: snake_case like every `Settings` key (no `rename_all`);
an older backend keeps the key in `extra`. StrictMode re-runs the warning
effect with the ref kept and the first timer cleared; a crossing already
warned is disarmed. `…One` keys present in all five files.

**Gates** (worktree, after the fixes)
- `npm run build`: ok.
- `npm test -- --reporter=dot`: 773 files / 7809 tests, all pass (+1 file,
  +3 tests).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`:
  ok. No Rust touched.

**Flagged for user**
- A hand-edited `shell_scrollback_rows` that is not a `u32` (negative, a
  string, > 4 294 967 295) makes the new backend refuse the whole
  `settings.json`, as every other `Option<u32>` field already does
  (`sleep_tabs_after_min`, …). The plan fixes the type; the app itself only
  writes the dropdown's values.
- `terminalViewKind` tests `if (p.kind)` where both old copies used `??`: a
  persisted tab with `kind: ""` (never written by the app) is now classed by
  its command instead of keeping `""`.
- A shell tab running an agent CLI through the shim keeps the shell cap
  (it is a shell tab); say if those should keep 5,000.

## T3 (implementer)

**Commit** (base `e322f1c7`): `1ed60f08` — Stop experimental flags following
Debug mode once a profile is migrated (plan step 3, one commit as the plan
splits it).

**What landed**
- `lib/experimental.ts`: `experimentalEnabled` = explicit value, else off on a
  profile with `experimental_explicit === true`, else the old `debug` fallback
  (`terminal_webgl` still opt-in everywhere). `explicitExperimentalPatch`
  (pure; `null` once marked; Debug on → `true` for every unset flag but
  `terminal_webgl`, plus the marker; otherwise the marker alone; never touches
  an explicit value, `false` included). `migrateExperimentalOnce` reads the
  store, skips unless `loaded && settings`, writes through `updateSettings`
  (optimistic guess = before + patch, so no frame shows a flag off), logs and
  leaves a failed write (the store rolls the guess back → still unmarked →
  next launch retries). Concurrent calls share one in-flight write. Module
  header rewritten.
- `AppShell` load effect: `Promise.resolve(loadSettings()).then(() =>
  migrateExperimentalOnce())`. Main window only by construction.
- `types/index.ts` + Rust `schema/settings.rs`: `experimental_explicit`
  named field; `experimental()` checks it; new `Settings::copilot_completion()`
  used by `copilot/policy.rs` and `invalidate_copilot`.
- `SettingsPanel`: Debug toggle gets help `settings.debugHelp` + pill
  `settings.debugNoExperiments`; new `deck_presenter` `ToggleCard`
  (pill `settings.deckPresenter`, search key); experimental help is
  Help1 + Help2 + Help3 (`experimentalHelpBold` deleted in all five files).
- i18n (5 files): new `settings.debugHelp`, `settings.deckPresenter`,
  `…Help`; rewritten `experimentalHelp1/2/3`, `lessons.deckPresenter.exportFlagBody`,
  `lessons.runPython.debugFileBody`.
- Comments that promised the debug default reworded: `types/index.ts`,
  `schema/settings.rs`, `commands/browser.rs`, `DeckView.tsx`,
  `FileViewerPane.tsx`, `TabBar.tsx`, `NewTabMenu.tsx`, `experimentalSweep.ts`,
  `lib/mail.ts`, `stores/mail.ts`, `AppShell.tsx`, `BrowserTripwire.test.ts`.
- `docs/guide/features.md`, filemap rows (`lib/experimental.ts`, backend
  `schema/settings.rs`), two `untested.ts` rows, QA row 2417 (T3.1, T3.2,
  four platform pairs each).

**Choices**
- `Promise.resolve(loadSettings())` rather than `loadSettings().then`: several
  AppShell tests mock `load` as a bare `vi.fn()` returning `undefined`. A
  rejected load still never reaches the migration and stays an unhandled
  rejection, as before.
- The migration also checks `loaded`, so a mocked/unloaded store with a
  non-null `settings` (SidePanelEdgeRail's mock) writes nothing.
- An explicit `experimental_explicit: false` counts as unmarked (only `true`
  marks), in TS and Rust; the migration then writes `true`.
- `experimentalEnabled` now tests `!= null` instead of `??`/`=== undefined`
  (same result for JSON-borne values; `null` never reaches it from Rust).
- Deck switch placed after the browser, before Python run/debug.
- `dev/perfMonitor` (`import.meta.env.DEV`), the project-settings Debug
  section (`ProjectFilesSettings.tsx`) and `browser_live_pages` untouched.

**Gotchas**
- `useSettingsStore.updateSettings` is optimistic: the migration's guess is
  in the store synchronously, which is what keeps the sweep/restore filter
  quiet between write and answer. A StrictMode second `load()` can land a
  stale unmarked snapshot after the guess; it still shows the same flags
  (old rule) and the in-flight guard stops a second write.

**Gates** (worktree, after `1ed60f08`)
- `npm run build`: ok.
- `npm test -- --reporter=dot`: 775 files / 7829 tests, all pass (baseline
  773 / 7809; +2 files `ExperimentalExplicit`, `DeckPresenterSetting`; +20
  tests).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `cargo test -q`: all pass (lib 3657 passed, 3 ignored; +3 tests).
  `cargo clippy --all-targets -D warnings`: clean. Windows `cargo check
  --target x86_64-pc-windows-msvc`: ok.
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`: ok.
- `npm run backend:stale`: the open window and its embedded phone bundle
  predate the current build (not running this branch). An older backend keeps
  `experimental_explicit` in `Settings.extra`, so it round-trips and the
  frontend reads it.

**Flagged for user**
- Not run live. QA row 2417 (T3.1 upgrade path with Debug on, T3.2 Debug off
  + Deck switch) is the manual check.
- On an older backend (stale window), Rust `experimental()` ignores the
  marker: a marked profile with Debug on and `copilot_completion` unset would
  still pass the backend Copilot policy there. A migrated Debug profile has it
  explicit, so this only bites a profile that turns Debug on later while the
  old binary runs.
- A profile whose Debug mode was on keeps every experiment ticked forever
  (the user decision); turning Debug off no longer turns them off — they are
  unticked one by one.
- No AppShell-level test drives the load → migrate wiring; it is covered by
  the unit tests of `migrateExperimentalOnce` and the one-line call.

## T3 (reviewer)

Range `e322f1c7..6fe52775` (main commit `1ed60f08`), bugs only.

**Fixes**

| Commit | Bug | Test |
|---|---|---|
| — | No confirmed bug found. | — |
| (this commit) | Coverage gap the implementer flagged: nothing drove AppShell's load → migrate wiring. | `src/__tests__/windows/AppShellExperimentalMigration.test.tsx` — the migration writes once, only after `loadSettings()` resolves; under `<StrictMode>` (two loads, the second a stale unmarked snapshot landing while the write is in flight) it still writes once. Fails if the call moves before the load or the in-flight guard goes. |

**Checked and sound**
- Every flag reader goes through `experimentalEnabled` / `useExperimental` /
  `withdrawnTabKinds` (main window, `DetachedApp` sweep, `stores/tabs` restore
  filter, `lib/mail.ts`, `steeringRegion`, SettingsPanel switches); no direct
  `settings.<flag>` read in `src/` or `mobile-web/` (the phone bundle reads no
  flag). Rust: every accessor (`python_run_debug`, `mail_client`,
  `deck_presenter`, `web_browser`, `copilot_completion`) goes through
  `experimental()`; no raw field or JSON-key read elsewhere. Both sides treat
  only `experimental_explicit === true` as marked.
- Popout before the migration lands: it loads unmarked → old rule → same
  flags; `SETTINGS_CHANGED_EVENT` then brings the marked snapshot with the
  ticks → still the same flags.
- Non-debug profile → marker only; Debug off with explicit flags → marker
  only, explicit values kept; idempotent across launches (marked → `null`);
  failed write rolls the guess back, profile stays unmarked, next launch
  retries.
- Copilot `authorize_project` / `invalidate_copilot`: for `debug` unset/false
  the accessor equals the old `unwrap_or(false)`; the migration's own write
  changes neither side of the comparison, so it never stops sessions.
- `settings.json`: snake_case `experimental_explicit` on both sides (no
  `rename_all`), named Rust field, omitted when unset.
- i18n: `settings.debugHelp`, `settings.deckPresenter`, `…Help`,
  `experimentalHelp1/2/3`, both lesson bodies present in all five files;
  `experimentalHelpBold` gone everywhere.
- `patch_settings` is a sync command (main thread, in arrival order), so a
  Settings toggle sent after the migration lands after it on disk.

**Gates** (worktree)
- `npm run build`: ok.
- `npm test -- --reporter=dot`: 776 files / 7831 tests, all pass (+1 file,
  +2 tests over the 775 / 7829 baseline).
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`: ok.
- No Rust touched; cargo gates not rerun.

**Flagged for user**
- The migration's patch is computed from the main window's first
  `get_settings` snapshot and sends unconditional `true`s for the flags unset
  there. A write landing between that read and the patch (another window or
  the phone unticking an experiment in those few milliseconds at startup)
  would be overwritten with `true`. No such writer exists at startup today,
  so not fixed; a backend-side "set if absent" would close it.
- Not run live (QA row 2417 stands).

## Final review (2026-10-10)

Whole range `7746648d..ee2262a0`: the S13 follow-ups and their review
(`docs/performance_handoff.md` `### S13`) plus T1–T3 and their reviews.
Cross-step integration, leftovers and bookkeeping; nothing run live.

**Checked**
- T1 readout × T2 live scrollback × S10 × S13: `terminalCost` reads the PTY
  id `<scope>:<key>` that `tabTerminalSpawn` gives every tab pane (box scopes
  included); an S10 sleeping pane reads "asleep" before any registry look, and
  its wake builds a fresh xterm from `scrollbackRowsRef`, so the readout's cap is
  the current setting; the live-cap effect is a no-op on an unbuilt or sleeping
  pane; an S13 failed-spawn pane keeps its xterm (and hold) and reads as a live
  terminal with its error text. Remote/Host-session holds have no xterm →
  "Not drawn yet", never a size.
- T1 PDF registry × S13 `texPanes` × §4.3 × popouts: TeX sub-pane viewers
  register under `<tab>#<path>` and sum under the tab (`pdfCostFor`'s `#`
  prefix cannot match `pdf-10` for `pdf-1`); `untabbedPdfCost` splits the same
  key. The §4.3 release unmounts `PdfCanvas` → entry gone; S13's
  `splitSubPaneKey` mirror hold keeps a popped-out workspace's main PDF pane
  loaded, so it is counted there (as T1 documented for plain PDFs). Registries
  and the toast host are per window; popouts never toast, the Settings list is
  main-window only. Sub-pane positions staged at hide are not flushed by
  `FileViewerPane`'s per-key flush, but a remount seeds from
  `pendingViewerState` and every save folds them (`savedViewerState`) — no loss.
- T3 × T1/T2: nothing T1/T2 added sits behind an experimental flag. All eight
  `EXPERIMENTAL_FLAGS` have a Settings switch (Deck presenter was the missing
  one). No direct `settings.debug` gate left besides the project-settings
  Debug section (deliberate); Rust reads every flag through `experimental()`.
- Settings page: search keys for `settings.shellScrollback`,
  `settings.tabCosts`, `settings.deckPresenter`; the two new Performance rows
  sit after the sleep-tabs row; all five new pills (`tabCost.hover`,
  `settings.tabCosts`, `settings.shellScrollback`,
  `settings.debugNoExperiments`, `settings.deckPresenter`) render and have
  `untested.ts` rows (`npm run untested -- list` shows them).
- Leftovers: no TODO/FIXME, debug logging, `any` or `dbg!` in added lines;
  every new export is used in production code or is a test seam
  (`_clearTabCostForTest`, `TEX_PANES_CAP`, `explicitExperimentalPatch`).
- i18n: all 31 added/rewritten English keys exist in de/es/fr/it;
  `experimentalHelpBold` is gone everywhere; no hard-coded display text in
  the added JSX.
- File maps: rows for `tabCost.ts`, `TabCostList.tsx`, `PdfLoadWarningHost.tsx`,
  `lib/terminal/scrollback.ts`, `experimental.ts`, `TerminalView.tsx`,
  `terminalSpawn.ts`, `PdfViewer.tsx`, `tabs.ts`, backend `settings.rs`. The
  `PdfLoadWarningHost.tsx` row predated the T1/T2 review fixes (own toast slot,
  grace-end look); updated.
- QA rows 2414 (S13.1–4), 2415 (T1.1–3), 2416 (T2.1), 2417 (T3.1–2): every
  manual box has the four platform pairs.
- Persisted JSON: `shell_scrollback_rows` and `experimental_explicit` are
  named Rust fields, omitted when unset, parsed from files without them
  (Rust tests); an older backend carries both in `extra`. `viewerState.texPanes`
  rides the backend's opaque `viewerState`; an older frontend's
  `{ ...viewerState, ...patch }` writes keep it.
- Quit: the only new timers are `PdfLoadWarningHost`'s grace-end and toast
  timeouts (cleared on unmount) and the existing one-shot viewer flush; no new
  process, listener or interval.

**Fixes**

| Commit | Bug | Test |
|---|---|---|
| — | No confirmed bug found. | — |

Doc only: the `PdfLoadWarningHost.tsx` file-map row; status lines here and in
the plan.

**Gates** (worktree, at `ee2262a0` + this doc commit)
- `npm run build`: ok (tsc + both bundles).
- `npm test -- --reporter=dot`: 776 files / 7831 tests, all pass.
- `npm run lint`: 0 errors / 28 warnings (unchanged).
- `cargo test -q`: all pass (lib 3657 passed, 3 ignored). `cargo clippy
  --all-targets -D warnings`: clean. Windows `cargo check --target
  x86_64-pc-windows-msvc`: ok.
- `scripts/brand-check.sh`, `scripts/privacy-check.sh 7746648d..HEAD`,
  `git diff --check 7746648d HEAD`: ok.

**Flagged for user — consolidated (T1–T3 implementer/reviewer and S13; fixed
ones marked)**
- Nothing in this range was run live: QA rows 2414–2417 are the manual checks,
  including the `+108px` toast slot (T1.3 after a project switch) and the 0.9
  glass fill (S13.4, picked without a live look).
- ~~Hover row showed the old 5,000 cap until T2~~ — fixed by T2 (`a5ef5292`).
- ~~Toast sat on the connection toast~~ — fixed `4c083d49`.
- ~~A crossing of 8 inside the 2-min grace never toasted on an unmoved count~~
  — fixed `5501a9da` (grace-end look) and `d30eec1e` (timer firing early).
- ~~"1 PDFs" / "1 more tabs" / "1 pages"~~ — fixed `5501a9da`.
- ~~Help text hard-coded the agents' "5,000"~~ — fixed `a1bd6236`.
- ~~No test drove AppShell's load → migrate wiring~~ — added `ee2262a0`.
- ~~HPC connect-then-spawn retry left `spawnState` "failed"~~ — fixed
  `34459a71`.
- Threshold 8 / re-arm 5 / grace 2 min are constants, not settings.
- "N more tabs hold nothing loaded" also counts asleep terminals (program
  running) and popped-out tabs — wording only.
- A PDF or TeX workspace tab whose viewer has not mounted yet (never shown its
  PDF) reads "Unloaded — reloads when shown".
- New (final review): the toast's second line is 90–112 characters in the five
  languages and `.project-switch-toast.multiline` is `white-space: pre` with
  an ellipsis, so a window narrower than roughly 950 px clips it. Cosmetic,
  not changed.
- Lowering the shell scrollback trims open shells at once; raising it does not
  bring lines back (by design, said in the help).
- A shell tab running an agent CLI through the shim keeps the shell cap.
- A hand-edited non-`u32` `shell_scrollback_rows` makes the backend refuse the
  whole `settings.json`, like every other `Option<u32>` field.
- `terminalViewKind` tests `if (p.kind)`: a persisted `kind: ""` (never
  written by the app) is now classed by its command.
- On an older backend (stale window) Rust `experimental()` ignores the marker:
  a marked profile that turns Debug on later with `copilot_completion` unset
  would pass the old binary's Copilot policy.
- A Debug-mode profile keeps every migrated experiment ticked; Debug off no
  longer turns them off (user decision).
- The migration's patch comes from the first `get_settings` snapshot; a write
  from another window or the phone in the few ms before it lands would be
  overwritten with `true` (no such writer at startup today; a backend
  "set if absent" would close it).
- S13: a sub-pane's per-tab settings (child `fontSize`, AI toggles,
  breakpoints) now persist in `texPanes` too; entries for files no longer in
  the structure stay until they age out of the 32 cap.
- S13: every sub-pane flush re-renders the TeX workspace once (≤ every 5 s
  while scrolling), not measured.
- S13: a failed-spawn pane stays awake until relaunch/close, including a
  declined HPC question; a later Connect does not retry that tab (by decision).
