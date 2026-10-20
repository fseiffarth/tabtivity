# Tab cost readout, PDF warning, scrollback, experimental default — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Status: implemented + reviewed (T1–T3, each step reviewed; final review
2026-10-10, `docs/done/tab_cost_handoff.md`) on branch `perf`. Not landed on
`develop`, not run live. Follows the four items of
`docs/performance_plan.md` §10 on branch `perf` (S1–S13 landed).
Code read at `df4df1fa`; line refs are from there.

## Why

- `AppResourceUsage` is process-wide and the renderer is one process, so `/proc`
  cannot say which tab holds the memory: the user cannot tell what to close, and
  later perf steps have nothing to attribute against.
- Nothing warns when many PDFs are loaded at once. With §4.3 (hidden PDFs
  release after `PDF_DOC_RELEASE_MS`, 5 min) and §5.3 (sleeping panes), a high
  count means the user is flipping PDFs or holds keep them loaded — worth one
  soft notice.
- `scrollback: 5000` is hard-coded in `TerminalView.tsx` `buildTerm` (`:454`).
  xterm keeps about rows × cols × 12 B per terminal; a shell needs less history
  than an agent.
- `experimentalEnabled` (`src/lib/experimental.ts:71`) returns
  `settings[flag] ?? settings.debug`, so Debug mode mounts every experiment. The
  backend copies the rule (`schema/settings.rs:1062`, `services/copilot/policy.rs:27`,
  `commands/settings.rs:102-103`).

## Fixed decisions

**Readout (1)**
- **An estimate, read on demand.** No bookkeeping in hot paths, no timer.
  - *Terminal* (`isPtyTabKind`; PTY id `${scope}:${key}`, as `PaneSlot`):
    `terminalFor(ptyId)` (`lib/terminal/terminalRegistry`) → `buffer.normal.length`
    rows, `cols`, `options.scrollback`. Estimate = rows × (cols × 12 + 64) B
    (xterm `BufferLine` = `Uint32Array`, 3 words per cell). States with no
    estimate, never shown as zero: *asleep* (`asleepPty(id)`: "the program keeps
    running"), *elsewhere* (main window, `isDetachedPtyId(id)`: shown in a
    pop-out), *not drawn yet* (§5.2: no xterm until first shown).
  - *PDF:* summed `doc.numPages` over `sourcesRef` plus the viewed file's
    `docBytes` and any merged source's `bytes.byteLength`; estimate = 2 × bytes.
    A registry entry without a document yet (loading, or a failed load) gives
    no line. A PDF tab with no entry shows *unloaded* ("reloads when shown"):
    the §4.3 release and a sleeping pane both look like that; a popped-out tab
    shows *elsewhere* instead.
  - *Other kinds:* no line. Out of scope: renderer canvases/GL (released after
    `RENDERER_RELEASE_MS` hidden), painted PDF page bitmaps, the backend's PTY
    replay buffers (Rust heap).
- **One new module, `src/lib/tabCost.ts`:** the PDF document registry plus pure
  readers/rankers. No Zustand store — the data is read when displayed, so a
  store would turn every PDF load into a write nobody subscribes to. Per window,
  like `terminalRegistry`; in a popout the card reads that window's own
  registries and skips the *elsewhere* check.
- **Where it shows.**
  - **Memory** row in `TabHoverCard`, read in render. The card's existing 10 s
    tick refreshes it; no timer of its own. Shown for PTY kinds, `embed` PDF and
    `texworkspace` viewers, and any tab with a registry entry (a Files tab
    previewing a PDF).
  - **"What open tabs hold"** list on Settings → Performance, under the
    sleep-tabs row, main window only (`!isDetachedWindow()`). Read on mount and
    on a **Refresh** button, no interval. Largest estimate first; tabs with no
    estimate collapse into one count line; registry entries matching no tab
    (side-panel previews) into one "outside a tab" line.
- **List actions use only existing calls.**
  - **Close:** `closeTabInScope(scope, key)` (`lib/remote/closeRemoteTab.ts`),
    any scope.
  - **Show:** `useTabsStore.getState().setActive(key)` then the dialog's
    `onClose`; current-scope tabs only (switching project from inside Settings is
    not trivial).
- **The tab set:** `tabsByScope`, current scope from `tabs`. Keys are unique
  across scopes (as `scopeOfTab` assumes). A TeX workspace's PDF sub-pane
  (`<tab>#<path>`, `splitSubPaneKey`) counts under its tab.

**PDF warning (2)**
- **What is counted:** main-window registry entries with a loaded document. A
  released (§4.3) or sleeping (§5.3) PDF has unmounted its `PdfCanvas`, so it
  drops out by construction. A popped-out PDF's main copy: the §4.5 stub
  unmounts it at once while sleeping is on; with "Unload hidden tabs after" =
  Never, `PdfView` holds it (`mirrored`) and it *is* counted — it really holds a
  document. Popout windows, `PdfPresentApp` and the deck presenter are other
  windows and not counted.
- **Threshold:** `PDF_LOADED_WARN_AT = 8` in `tabCost.ts`, a constant like its
  siblings `PDF_DOC_RELEASE_MS`/`PDF_PAGE_RELEASE_MS`.
- **Hysteresis:** fires when the count reaches ≥ 8 while armed, then disarms;
  re-arms at ≤ 5 (`PDF_LOADED_REARM_AT`). Never within `PDF_WARN_GRACE_MS` = 2
  min of window start (`performance.now()`, no timer): a restore with many PDF
  tabs is transient, §4.3 releases the hidden ones. A crossing in the grace
  period stays armed, so the next count change after it fires if still ≥ 8.
- **Mechanism:** AppShell's existing toast, the `connToast` pattern: classes
  `project-switch-toast conn-toast multiline`, local state cleared by a one-shot
  3.2 s `setTimeout` (the `.conn-toast` animation), `pointer-events: none`.
  Non-blocking, self-dismissing, no new visual treatment. The text names the
  count and points at Settings → Performance. It lives in a small
  `PdfLoadWarningHost` in AppShell (main window only), subscribed to the
  registry, which notifies only when `loadedPdfCount()` changes — never per
  render or reload.
- **Sleep setting:** same text whatever it says — hidden PDFs release after 5
  min even with Never, because §4.3's constant is independent of it.

**Scrollback (3)**
- **One setting `shell_scrollback_rows?: number`** (Rust `Option<u32>`, named
  field with `skip_serializing_if`, like `sleep_tabs_after_min`). Absent or
  invalid → 2,000; clamped to [100, 50,000]. Choices 1,000 / 2,000 / 5,000 /
  10,000. Applies to every `TerminalView` whose kind is not `agent`/`local_agent`:
  shell tabs and the dialogs' connection terminals.
- **Agent tabs keep a constant 5,000** (`AGENT_SCROLLBACK_ROWS`): Claude-style
  TUIs draw the conversation into the normal buffer, and the Reader, keyboard
  select and steering scroll read it back. A second setting would add a row
  nobody asked for.
- **Kind:** the kind `TerminalView` already derives at `:818-819`
  (`declaredKind ?? (localModel ? "local_agent" : cmdToKind(cmd))`), hoisted
  into one helper both the spawn effect and the scrollback use, so they cannot
  disagree.
- **Applied live, never through the spawn effect** — the `webglWanted` pattern
  (`:404-407`, effect at `:2059`): a ref read in `buildTerm`, plus a separate
  effect keyed on the rows that sets `termRef.current.options.scrollback`.
  Shrinking trims open shells at once; the help text says so. It must NOT become
  a spawn-effect dependency or enter `TerminalSpawnInputs`/`terminalSpawnKey`
  (S10 gotcha), or a settings change would respawn or wake PTYs.
- **Interactions checked.** Backend buffers are bytes, not rows: the S5 replay
  trim, S10's 1 MB `ROUTE_SLEEP_SCROLLBACK_CAP` wake tail, `PENDING_OUTPUT_CAP`
  (1 MB). A smaller xterm cap only drops more of a wake tail or hidden-pane
  flush on write; nothing beyond what scrolled off is lost. Phone history comes
  from the backend (`pty_scrollback`). The readout's "rows of cap" lets the user
  judge the default.

**Experimental default (4)** — user decision 2026-10-10: keep today's Debug-mode
experiments, migrate once.
- **New rule:** once a profile is *marked* (`experimental_explicit: true`), an
  unset flag is off whatever Debug says; an explicit value still wins.
- **Unmarked profiles keep the old rule** (unset → `debug`, `terminal_webgl`
  excepted) in `experimentalEnabled` and Rust `experimental()`. *Decision
  (review):* this makes the migration semantics-preserving in every window
  and at every moment. Without it, the first render after `get_settings` (or a
  popout loading first, or the restore filter in `stores/tabs`) would see a
  debug user's flags as off and `withdrawnTabKinds` → `closeTabsOfKinds`
  would close browser tabs before the patch landed. The legacy branch is dead
  for a profile from its first main-window load on.
- **One-shot migration.** `migrateExperimentalOnce()` in `lib/experimental.ts`,
  called from AppShell's load effect after `loadSettings()` resolves — main
  window by construction (`DetachedApp` and the other window roots never call
  it). It applies pure `explicitExperimentalPatch(settings)` through
  `updateSettings` (backend `patch_settings`, merged under the mutation lock):
  - marker already set → `null`, nothing written (does not re-run);
  - `debug === true` → every *unset* flag except `terminal_webgl` → `true`,
    plus the marker; explicit values are never touched;
  - otherwise → the marker alone.
  A failed write is logged and retried next launch; the patch is idempotent. A
  failed `load()` never reaches it, so it never writes onto an unloaded store.
  A stale backend keeps the marker in `Settings.extra`, so it round-trips.
- **Rust:** a named `experimental_explicit: Option<bool>` with round-trip test;
  `experimental()` gains the marker check. *Decision:* a new
  `Settings::copilot_completion()` accessor through `experimental()` replaces the
  hand-copied rule in `copilot/policy.rs:27` and `invalidate_copilot`
  (`commands/settings.rs:102-103`), so the rule has one Rust spelling.
- **Deck presenter gets a switch.** *Decision (review):* `deck_presenter` has no
  Settings toggle today (`lessons.deckPresenter.exportFlagBody` says so); under
  the new rule a profile marked with Debug off could never reach it. T3 adds a
  `ToggleCard` in the experimental section like its siblings.
- **Debug-only behaviour that is not a flag stays:** `ProjectFilesSettings.tsx:631`
  (project Debug section), the Debug toggle itself, and the dev perf monitor
  (gated by `import.meta.env.DEV`, not `debug`).
- **Entry points the fallback mounted** (all `useExperimental`, plus the switches
  at `SettingsPanel.tsx:2076-2160`):
  - `mail_client`: `MailIndicator`, `MailOverlay`, `AlertsSection`,
    `useAlertsFeed`, `TodoPane`, `TodoCardDialog`, `TodoMailRail`,
    `PdfViewer:1936`, `lib/mail.ts:623` (mail AI), `steeringRegion.ts:43`.
  - `web_browser`: `NewTabMenu`, `TabBar:516`, `PdfViewer:1935`, and the browser
    tab kind (`withdrawnTabKinds`, `experimentalSweep`, the `DetachedApp` and
    `stores/tabs` restore filter).
  - `deck_presenter`: `FileBrowser:94`, `FileTree:990`, `FileViewerPane:489`,
    `PdfViewer:1931`.
  - `project_remarks`: `FileTree:926`, `ProjectFilesView:397`, `FileViewerPane:7450`.
  - `python_run_debug`: `FileViewerPane:7440`. `md_graph`: `FileViewerPane:8003`.
  - `copilot_completion`: `FileViewerPane:3250/6416`, backend policy and
    `invalidate_copilot`.
- **Tests that pin the fallback** keep passing as the *unmarked* case and gain a
  marked case: `Experimental.test.ts`, `ExperimentalSweep.test.ts:45-51`,
  `ExperimentalTabWithdraw.test.ts:85-92`, `PythonViewer.test.tsx:332`; Rust
  `experimental_flags_default_to_debug_mode` (`settings.rs:1222`, rename to say
  unmarked), `settings.rs:1464`, `browser.rs:1286`, `policy.rs:145`.

## Steps

### Step 1 — Tab cost registry, hover row, settings list, PDF warning (1.25 d)

1. **New `src/lib/tabCost.ts`.**
   - Registry: `registerPdfDoc(token, { tabKey?, path })`,
     `updatePdfDoc(token, { pages, bytes })`, `unregisterPdfDoc(token)`,
     `loadedPdfCount()`, `pdfCostFor(tabKey)` (sums `<tabKey>#…` sub-panes),
     `untabbedPdfCost(tabKeys)`, `subscribeLoadedPdfCount(cb)` (notifies only
     when the count changes).
   - Readers: `terminalCost(ptyId)` → `{ state: "live" | "asleep" | "elsewhere"
     | "unbuilt", rows?, cols?, cap?, estBytes? }`; `tabCost(scope, tab)` →
     terminal | pdf | unloaded | elsewhere | null; `rankTabCosts(entries)`.
   - `pdfWarnStep(state, count, nowMs)`: pure hysteresis step, plus the constants.
   - Sizes via `lib/formatBytes.ts`. Test seam `_clearTabCostForTest`.
2. **`PdfViewer.tsx` `PdfCanvas`.** Register in the unmount effect (`:4161`, same
   token; unregister beside `slot.dispose`). One small effect on
   `[sources, docBytes]` calls `updatePdfDoc` with summed `numPages` and bytes;
   the load path is untouched.
3. **`components/tabs/TabHoverCard.tsx`:** a `tabCost.label` row in the existing
   `pill-popup-path-row` classes, read in render, its text added to the layout
   effect's deps.
4. **New `components/layout/TabCostList.tsx`**, rendered in `SettingsPanel.tsx`'s
   `performance` section after the sleep-tabs row (`:1986-2006`): one
   `SettingsCard`, rows in `settings-link-row`/`settings-btn`, Show/Close as
   decided, a header line with the loaded-PDF count, Refresh. Add
   `settings.tabCosts` to the section's search list (`:1189`).
5. **New `components/layout/PdfLoadWarningHost.tsx`**, mounted in `AppShell.tsx`
   beside the toasts (`:1241-1246`): subscribes, runs `pdfWarnStep`, renders the
   toast div, clears it with the one-shot timeout.
6. **i18n** (English `src/lib/i18n.ts` + `i18nDicts/{de,es,fr,it}.ts`),
   **`untested.ts`** rows with pills on the hover label and the list title,
   **filemap rows** for `lib/tabCost.ts`, `TabCostList.tsx`,
   `PdfLoadWarningHost.tsx`, plus one clause on the `PdfViewer.tsx` row.

Acceptance: `rg setInterval` over the three new files = 0; `TerminalView.tsx`
and `terminalBus.ts` untouched; a §4.3 release drops the count by one; no
reading ever renders as 0 B.

Tests:
- `src/__tests__/shell/TabCost.test.ts`: registry counts and notify-only-on-change;
  `terminalCost` with a fake terminal via `registerTerminal`, asleep via
  `markPtyAsleep`, elsewhere via a detached group, unbuilt; ranking;
  `pdfWarnStep` fires once at 8, not at 9, re-arms at 5, quiet in the grace
  period and fires after it.
- `src/__tests__/pdf/PdfCostRegistry.test.tsx` (harness of
  `pdf/PdfSleepHidden.test.tsx`): load → count 1 with pages/bytes; hidden 5 min →
  0; shown → 1; unmount → 0.
- `src/__tests__/tabs/TabHoverCardCost.test.tsx`: terminal, asleep, PDF and
  unloaded rows; no row for a calendar tab.
- `src/__tests__/shell/TabCostList.test.tsx`: sorted rows; Close →
  `closeTabInScope`; Show only for current-scope tabs and calls `onClose`;
  Refresh re-reads; collapsed count line.
- `src/__tests__/shell/PdfLoadWarningHost.test.tsx`: 8 loads after the grace
  period → one toast; a 9th → none.

### Step 2 — Shell scrollback setting (0.5 d)

1. **New `src/lib/terminal/scrollback.ts`:** `SHELL_SCROLLBACK_DEFAULT = 2000`,
   `SHELL_SCROLLBACK_CHOICES`, `AGENT_SCROLLBACK_ROWS = 5000`,
   `shellScrollbackRows(v)` (default + clamp), `scrollbackRowsFor(kind, setting)`.
2. **`components/terminal/TerminalView.tsx`:** hoist the kind derivation; subscribe
   to `s.settings?.shell_scrollback_rows`; a ref read in `buildTerm` instead of
   `5000`; a separate `useEffect([rows])` setting `termRef.current.options.scrollback`,
   commented "not a spawn dep".
3. **`src/types/index.ts`** field; **`schema/settings.rs`** named `Option<u32>`
   and a round-trip test after the `sleep_tabs_after_min` one (`:1321`).
4. **`SettingsPanel.tsx`:** `SettingRow` + `Dropdown` after the sleep-tabs row,
   same shape, in the search list, pill `settings.shellScrollback`.
5. i18n (5 files), `untested.ts`, filemap: the `TerminalView` row and a row for
   the new module.

Acceptance: a settings change issues no `pty_spawn`/`pty_kill` and leaves
`terminalSpawnKey` unchanged; `npm run backend:stale` run and reported (an old
backend keeps the key in `Settings.extra`).

Tests:
- `src/__tests__/terminal/Scrollback.test.ts`: default, clamp, per kind.
- `src/__tests__/terminal/TerminalScrollback.test.tsx` (xterm mock as in
  `TerminalSleepWake.test.tsx`): shell builds with 2,000, agent with 5,000; a
  setting change updates `options.scrollback` live with no `pty_kill`/`pty_spawn`.
- Rust `shell_scrollback_rows_defaults_absent_and_round_trips`.

### Step 3 — Experimental flags off once marked (1 d)

1. **`src/lib/experimental.ts`:** the marked/unmarked rule, a rewritten module
   header, `explicitExperimentalPatch`, `migrateExperimentalOnce`;
   `experimental_explicit?: boolean` in `src/types/index.ts`.
2. **`AppShell.tsx`:** `loadSettings().then(migrateExperimentalOnce)` in the load
   effect (`:423-424`).
3. **Rust:** `schema/settings.rs` marker field + round-trip test, `experimental()`
   with the marker, `copilot_completion()` accessor; `copilot/policy.rs` and
   `commands/settings.rs` call it. Rewrite doc comments that promise the debug
   default (`rg -n "debug mode|debug build" src-tauri/src/schema/settings.rs
   src/types/index.ts src/components/embed/deck/DeckView.tsx`). Tests above plus
   a policy test: marked, debug on, flag unset → `Disabled`.
4. **`SettingsPanel.tsx`:** reword the Debug comment (`:2060`); Debug toggle gets
   help `settings.debugHelp` and pill `settings.debugNoExperiments`; new
   `deck_presenter` `ToggleCard` (`settings.deckPresenter`/`…Help`, pill, search
   list `:1191`).
5. **i18n (5 files):** rewrite `settings.experimentalHelp1`/`2`, and `…Help3`
   (it still names Mail as owning a tab); delete `settings.experimentalHelpBold`;
   rewrite `lessons.deckPresenter.exportFlagBody` and
   `lessons.runPython.debugFileBody`, which promise "on in debug mode".
6. **Docs:** `docs/guide/features.md:341-345`; filemap row `lib/experimental.ts`
   (`:373`).

Acceptance: `{ debug: true, experimental_explicit: true }` renders no
experimental entry point; `{ debug: true }` unmarked keeps every entry point on
through the first load, which writes explicit `true`s (not `terminal_webgl`) and
the marker, and open browser tabs survive; a second load writes nothing;
`npm run backend:stale` run and reported.

Tests:
- The fallback tests above, unmarked as-is plus a marked case each.
- `src/__tests__/shell/ExperimentalExplicit.test.ts`: debug + unset → all but
  webgl plus the marker; debug off → marker only; marked → `null`; an explicit
  `false` is never overwritten; `migrateExperimentalOnce` writes once and a
  second call writes nothing; a rejected write leaves the profile unmarked.

## i18n keys (English in `src/lib/i18n.ts`; de/es/fr/it dictionaries)

New:
- `tabCost.label` ("Memory"); `tabCost.terminal` ("≈ {size} · {rows} of {cap}
  lines"); `tabCost.terminalAsleep` ("Unloaded — the program keeps running");
  `tabCost.terminalUnbuilt` ("Not drawn yet"); `tabCost.elsewhere` ("Shown in a
  pop-out window"); `tabCost.pdf` ("≈ {size} · {pages} pages, {file} file");
  `tabCost.unloaded` ("Unloaded — reloads when shown")
- `settings.tabCosts`, `…Help`, `…Refresh`, `…Show`, `…Close`, `…Empty`,
  `…Others` ("{n} more tabs hold nothing loaded"), `…Untabbed` ("{n} PDFs open
  outside a tab"), `…PdfCount`
- `pdfWarn.toast` ("{n} PDFs are loaded at once.\nHidden ones unload after 5 min
  — Settings › Performance shows what each tab holds.")
- `settings.shellScrollback`, `…Help`, `…Lines`
- `settings.debugHelp`, `settings.deckPresenter`, `settings.deckPresenterHelp`

Changed: `settings.experimentalHelp1/2/3`, `lessons.deckPresenter.exportFlagBody`,
`lessons.runPython.debugFileBody`. Removed: `settings.experimentalHelpBold`.

## UntestedTag ids (`src/lib/untested.ts`)

- `tabCost.hover`: the hover-card Memory row.
- `settings.tabCosts`: the list; its `what` also covers the PDF toast, which
  cannot carry a pill.
- `settings.shellScrollback`
- `settings.debugNoExperiments`: on the Debug toggle; covers the new rule and the
  migration.
- `settings.deckPresenter`: the new switch.

## QA rows (`todo/group-u-performance.md`, after 2414)

Every 🖐️ box gets the four platform ✅/❌ child pairs — Linux (X11), Linux
(Wayland), Windows, macOS — as in 2408.

- **2415. Per-tab cost readout and the loaded-PDF notice.**
  - 🤖 the Step 1 tests.
  - 🖐️ Hover a busy shell tab: "≈ … · N of 2,000 lines". Hover a PDF: pages and
    file size. Hover a PDF hidden over 5 min: "Unloaded". Hover a terminal
    asleep (Unload hidden tabs after 5 min): "the program keeps running", no size.
  - 🖐️ Settings → Performance → "What open tabs hold": largest first; Show jumps
    to the tab and closes Settings; Close closes it; Refresh updates.
  - 🖐️ Over 2 min after start, open 8 PDFs one after another: one toast at the
    8th, none at the 9th. Close down to 5, open three more: it shows once more.
- **2416. Shell scrollback setting.**
  - 🤖 the Step 2 tests.
  - 🖐️ A new shell keeps 2,000 lines (`seq 1 5000`, scroll to the top: 3001). An
    agent tab still keeps 5,000. Set 1,000: the open shell trims at once, no
    restart. Reopen Settings: 1,000.
- **2417. Experimental features no longer follow Debug mode.**
  - 🤖 the Step 3 tests.
  - 🖐️ With Debug on before updating: afterwards the same experiments are on and
    ticked, browser tabs still open. Untick Mail: it goes, and toggling Debug off
    and on does not bring it back.
  - 🖐️ On a profile with Debug off, turning Debug on shows no experiment; the new
    Deck presenter switch turns the PDF toolbar's Present button on.

## Agent steps

| Agent step | Plan step | Est. | Main files |
|---|---|---|---|
| T1 cost readout + PDF notice | Step 1 | 1.25 d | new `lib/tabCost.ts`, `TabCostList.tsx`, `PdfLoadWarningHost.tsx`; `PdfViewer.tsx` (two hunks), `TabHoverCard.tsx`, `SettingsPanel.tsx`/`AppShell.tsx` (mount hunks), i18n ×5, `untested.ts` |
| T2 shell scrollback | Step 2 | 0.5 d | `TerminalView.tsx`, new `lib/terminal/scrollback.ts`, `schema/settings.rs`, `SettingsPanel.tsx`, `types/index.ts`, i18n ×5 |
| T3 experimental default | Step 3 | 1 d | `lib/experimental.ts`, `AppShell.tsx` (one call), `schema/settings.rs`, `copilot/policy.rs`, `commands/settings.rs`, `SettingsPanel.tsx`, tests, i18n ×5, `features.md` |

- **Run in order.** All three touch `SettingsPanel.tsx` and the dictionaries;
  T2/T3 both touch `schema/settings.rs`; T1/T3 both touch `AppShell.tsx`.
- **Each step ends with** green gates (AGENTS.md), one commit, a fresh bugs-only
  reviewer, and its QA row. T2 and T3 also run `npm run backend:stale` and
  report it.

## Flagged for the user (not blocking)

- The warning threshold (8) and the 2-min start-up grace are constants. Say if
  you want them as settings.
- Review decisions above, open to veto: unmarked profiles keep the old rule
  until migrated; a Deck presenter switch is added; the copilot rule moves
  into one Rust accessor.
