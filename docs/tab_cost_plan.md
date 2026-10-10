# Tab cost readout, PDF warning, scrollback, experimental default — plan

Status: plan only (2026-10-09). Not implemented and not run live. Follows the
four items of `docs/performance_plan.md` §10 on top of branch `perf` (S1–S12
landed). Code was read at `b13a0df5`.

## Why

- `AppResourceUsage` is process-wide and the renderer is one process, so
  `/proc` cannot tell which tab holds the memory. The user has no way to see
  which tab to close, and later perf steps have nothing to attribute against.
- Nothing warns when many PDF documents are loaded at once. With §4.3
  (hidden PDFs release after `PDF_DOC_RELEASE_MS`, 5 min) and §5.3 (sleeping
  panes) in place, a high count means the user is actively flipping PDFs or
  holds keep them loaded. That is worth one soft notice.
- `scrollback: 5000` is hard-coded in `TerminalView.tsx` `buildTerm` (now
  `:454`). xterm keeps about rows × cols × 12 B per terminal, so a shell does
  not need an agent's history.
- `experimentalEnabled` (`src/lib/experimental.ts:71`) returns
  `settings[flag] ?? settings.debug`, so turning Debug mode on mounts every
  experimental entry point. The backend copies that rule
  (`schema/settings.rs:1062`, `services/copilot/policy.rs:27`,
  `commands/settings.rs:102`).

## Fixed decisions

**Readout (1)**
- **What counts as cost.** It is an estimate, read on demand, with no
  bookkeeping in hot paths.
  - *Terminal:* `terminalFor(ptyId)` (`lib/terminal/terminalRegistry`) →
    `buffer.normal.length` rows, `cols`, `options.scrollback`. Estimate =
    rows × (cols × 12 + 64) B (xterm `BufferLine` is a `Uint32Array` of
    3 words per cell). States: *live*; *asleep* (`asleepPty(id)` set: "the
    program keeps running"); *not drawn yet* (§5.2: no xterm until first
    shown).
  - *PDF:* summed pages (`doc.numPages` over `sourcesRef`) plus the viewed
    file's bytes (`docBytes`) and any merged source's `bytes.byteLength`.
    Estimate = 2 × bytes. A PDF tab with no entry shows *unloaded* ("reloads
    when shown"); that covers both the §4.3 release and a sleeping pane.
  - *Other kinds:* no line. Out of scope: renderer canvases and GL (already
    released after `RENDERER_RELEASE_MS` hidden), painted PDF page bitmaps,
    and the backend's PTY replay buffers (Rust heap, not the renderer).
- **One new module, `src/lib/tabCost.ts`.** It holds the PDF document
  registry and the pure readers/rankers. There is no Zustand store: the data
  is read when it is displayed, so a store would make every PDF load a store
  write that nobody subscribes to. The registry is per window, like
  `terminalRegistry`.
- **Where it shows.** Both places:
  - a **Memory** row in `TabHoverCard`, read in render. The card's existing
    10 s tick refreshes it, and it adds no timer of its own.
  - a **"What open tabs hold"** list on Settings → Performance, under the
    sleep-tabs row. It is read when the section mounts and again on a
    **Refresh** button, with no interval. Rows are sorted by estimate,
    largest first. Tabs with no reading collapse into one count line.
- **List actions use only existing calls.**
  - **Close:** `closeTabInScope(scope, key)` (`lib/remote/closeRemoteTab.ts`),
    in any scope.
  - **Show:** `useTabsStore.getState().setActive(key)` then the dialog's
    `onClose`. It is offered only for tabs of the current scope; switching
    project from inside Settings is not trivial.
- **The tab set** comes from `tabsByScope`, with the current scope taken from
  `tabs`. Tab keys are treated as unique across scopes, as `scopeOfTab`
  already assumes. A TeX workspace's PDF sub-pane (`<tab>#<path>`, via
  `splitSubPaneKey`) is counted under its tab.

**PDF warning (2)**
- **What is counted.** Registry entries with a loaded document in the main
  window. A released (§4.3) or sleeping (§5.3) PDF has unmounted its
  `PdfCanvas`, so it is out of the count by construction, whatever the sleep
  setting says.
  - The §4.5 stub already keeps a popped-out PDF's main copy unmounted.
  - Popouts, `PdfPresentApp` and the deck presenter are not counted: they
    are other windows or rare.
- **Threshold** is a constant, `PDF_LOADED_WARN_AT = 8` in `tabCost.ts`. Its
  sibling knobs (`PDF_DOC_RELEASE_MS`, `PDF_PAGE_RELEASE_MS`) are constants
  too.
- **Hysteresis.**
  - It fires when the count reaches ≥ 8 while armed, then disarms.
  - It re-arms only when the count drops to ≤ 5 (`PDF_LOADED_REARM_AT`).
  - It never fires within `PDF_WARN_GRACE_MS` = 2 min of window start, read
    from `performance.now()` with no timer. A restore with many PDF tabs is
    transient, because §4.3 releases the hidden ones. A crossing during the
    grace period stays armed, so the next load after it fires if the count is
    still high.
- **Mechanism.** It reuses AppShell's existing toast, the same pattern as
  `panelsHiddenToast`/`connToast`:
  - classes `project-switch-toast conn-toast multiline`;
  - local state cleared by a one-shot 3.2 s `setTimeout` (the class's
    animation);
  - `pointer-events: none`, so it never blocks.

  It is non-blocking and dismisses itself, with no new visual treatment. The
  text names the count and points at Settings → Performance.

  The logic sits in a small `PdfLoadWarningHost` component in AppShell
  (main window only). It subscribes to registry *count changes*: the
  registry notifies only on register, unregister, or a first load, never per
  render or reload.
- **Interaction with sleep.** The text is the same whatever the setting:
  hidden PDFs release after 5 min even with "Unload hidden tabs after" set to
  Never, because §4.3's constant is independent of it.

**Scrollback (3)**
- **One setting:** `shell_scrollback_rows?: number`.
  - In Rust it is `Option<u32>`, a named field with
    `skip_serializing_if`, following `sleep_tabs_after_min`.
  - Absent or invalid → 2,000; values are clamped to [100, 50,000].
  - Choices: 1,000 / 2,000 / 5,000 / 10,000.
  - It applies to every `TerminalView` whose `kind` is not
    `agent`/`local_agent`: shell tabs and the dialogs' connection terminals.
- **Agent tabs keep a constant 5,000** (`AGENT_SCROLLBACK_ROWS`).
  - Claude-style TUIs draw the conversation into the normal buffer, and the
    Reader, keyboard select and steering scroll read it back.
  - A second setting would add a row nobody asked for.
- **It applies live, never through the spawn effect.**
  - `TerminalView` reads the rows through a ref in `buildTerm`.
  - A separate effect keyed on the rows sets `termRef.current.options.scrollback`.
    Shrinking trims open shell tabs at once, and the help text says so.
  - It must NOT become a spawn-effect dependency or enter
    `TerminalSpawnInputs`/`terminalSpawnKey` (S10 gotcha), or a settings
    change would respawn or wake PTYs.
- **Interactions checked.** The backend buffers are measured in bytes, not
  rows: the S5 replay trim, S10's 1 MB `ROUTE_SLEEP_SCROLLBACK_CAP` wake
  tail, and `PENDING_OUTPUT_CAP` (1 MB).
  - A smaller xterm cap only drops more of a wake tail or a hidden-pane
    flush on write. Nothing else is held or lost beyond what scrolled off.
  - Phone history comes from the backend (`pty_scrollback`), not xterm.
  - The readout shows "rows of cap", which lets the user judge the new
    default.

**Experimental default (4)**
- **New rule:** an unset flag is off, whatever Debug mode says. An explicit
  value still wins. `terminal_webgl`'s special case disappears, because it
  is now the general rule.
- **One-shot migration** keeps a debug-mode user's current screen.
  - On the main window's first settings load without
    `experimental_explicit: true`, the pure function
    `explicitExperimentalPatch(settings)` (in `lib/experimental.ts`) returns
    a patch:
    - debug on: every unset flag except `terminal_webgl` → `true`;
    - always: `experimental_explicit: true`.
  - It is applied once through `updateSettings`, which is CAS-safe.
    Popouts skip it (`getDetachedWindowContext()`).
  - Without it, a debug user's open browser tabs would be withdrawn
    (`withdrawnTabKinds` → `closeTabsOfKinds`) and mail would vanish.
  - The marker is a named Rust `Option<bool>` with a round-trip test.
- **Debug-only behaviour that is not a flag stays as is:**
  - `ProjectFilesSettings.tsx:631` (project Debug section);
  - the Debug toggle itself;
  - the dev perf monitor, which is gated by `import.meta.env.DEV`, not
    `debug`, so nothing relies on the fallback.
- **Entry points the fallback mounted until now** (all `useExperimental`,
  plus the settings switches at `SettingsPanel.tsx:2076-2160`):
  - `mail_client`: `MailIndicator`, `MailOverlay`, `AlertsSection`,
    `useAlertsFeed`, `TodoPane`, `TodoCardDialog`, `TodoMailRail`,
    `PdfViewer:1936`, `lib/mail.ts:623` (mail AI), and
    `steeringRegion.ts:43`.
  - `web_browser`: `NewTabMenu`, `TabBar:516`, `PdfViewer:1935`, and the
    browser tab kind (`withdrawnTabKinds`, `experimentalSweep`, the
    `DetachedApp` and `stores/tabs` restore filter).
  - `deck_presenter`: `FileBrowser`, `FileTree:990`,
    `FileViewerPane:489`, `PdfViewer:1931`.
  - `project_remarks`: `FileTree:926`, `ProjectFilesView:397`,
    `FileViewerPane:7450`.
  - `python_run_debug`: `FileViewerPane:7440`.
  - `md_graph`: `FileViewerPane:8003`.
  - `copilot_completion`: `FileViewerPane:3250/6416`, plus the backend's
    `copilot/policy.rs` and `invalidate_copilot`.
- **Tests that relied on the fallback, to rewrite:**
  - `Experimental.test.ts`
  - `ExperimentalSweep.test.ts:45-51`
  - `ExperimentalTabWithdraw.test.ts:85-92`
  - `PythonViewer.test.tsx:332` ("debug mode turns it on")
  - Rust `experimental_flags_default_to_debug_mode` (`settings.rs:1222`),
    `settings.rs:1464`, `browser.rs:1286`, and the copilot policy test
    (`policy.rs:145`).

## Steps

### Step 1 — Tab cost registry, hover row, settings list, PDF warning (1.25 d)

1. **New `src/lib/tabCost.ts`.**
   - PDF registry: `registerPdfDoc(token, { tabKey?, path })`,
     `updatePdfDoc(token, { pages, bytes })`, `unregisterPdfDoc(token)`,
     `loadedPdfCount()`, `pdfCostFor(tabKey)` (sums sub-pane keys), and
     `subscribeLoadedPdfCount(cb)`, which notifies only when the count
     changes.
   - Readers: `terminalCost(ptyId)` returns `{ state: "live" | "asleep" |
     "unbuilt", rows, cols, cap, estBytes }`; `tabCost(scope, tab)` returns
     terminal | pdf | unloaded | null; `rankTabCosts(entries)`.
   - Warning logic: `pdfWarnStep(state, count, nowMs)`, a pure hysteresis
     step, plus the constants above.
   - Formatting goes through `lib/formatBytes.ts`.
   - Test seam: `_clearTabCostForTest`.
2. **`PdfViewer.tsx` `PdfCanvas`.**
   - Register in the unmount effect at `:4164` (same token; unregister
     beside `slot.dispose`).
   - Add one small effect on `[sources, docBytes]` that calls
     `updatePdfDoc` with summed `numPages` and bytes. The load path itself
     is not touched.
3. **`components/tabs/TabHoverCard.tsx`.** Add a `tabCost.label` row using
   the existing `pill-popup-path-row` classes, read in render and added to
   the layout effect's deps. Only for PTY kinds and PDF viewers (including
   `texworkspace`).
4. **New `components/layout/TabCostList.tsx`, rendered in `SettingsPanel.tsx`'s
   `performance` section after the sleep-tabs row.**
   - Wrapped in the existing `SettingsCard`, with rows in the
     `settings-link-row` / `settings-btn` classes.
   - Show and Close buttons as decided.
   - A header line with the loaded-PDF count.
   - Add the label to the section's search list (`:1189`).
5. **New `components/layout/PdfLoadWarningHost.tsx`, mounted in
   `AppShell.tsx` beside the toasts (`:1244`).** It subscribes, runs
   `pdfWarnStep`, renders the toast div and clears it with a one-shot
   timeout.
6. **i18n** in `src/lib/i18n.ts` + `i18nDicts/{de,es,fr,it}.ts`.
   **`untested.ts`** rows; pills on the hover row label and the list title.
   **Filemap rows:** `lib/tabCost.ts`, `TabCostList.tsx`,
   `PdfLoadWarningHost.tsx`, and a one-line addition to `PdfViewer.tsx`.

Acceptance:
- `rg "setInterval" src/lib/tabCost.ts src/components/layout/TabCostList.tsx
  src/components/layout/PdfLoadWarningHost.tsx` = 0.
- `TerminalView.tsx` and `terminalBus.ts` are untouched by this step.
- A PDF released by §4.3 drops the count by one.

Tests:
- `src/__tests__/shell/TabCost.test.ts`:
  - registry counts and notify-only-on-change;
  - `terminalCost` with a fake terminal via `registerTerminal`, the asleep
    state via `markPtyAsleep`, and unbuilt;
  - ranking order;
  - `pdfWarnStep` fires once at 8, stays quiet at 9, re-arms at 5, and is
    suppressed in the grace period but fires after it.
- `src/__tests__/viewers/PdfCostRegistry.test.tsx` (harness of
  `PdfSleepHidden.test.tsx`): load → count 1 with pages/bytes; hidden 5 min
  → 0; shown → 1; unmount → 0.
- `src/__tests__/shell/TabHoverCardCost.test.tsx`: terminal row, PDF row,
  unloaded row, no row for a calendar tab.
- `src/__tests__/settings/TabCostList.test.tsx`: sorted rows; Close →
  `closeTabInScope`; Show only for current-scope tabs and calls `onClose`;
  Refresh re-reads; no `setInterval`.
- `src/__tests__/shell/PdfLoadWarningHost.test.tsx`: 8 registrations after
  the grace period → one toast; a 9th → no second toast.

### Step 2 — Shell scrollback setting (0.5 d)

1. **New `src/lib/terminal/scrollback.ts`:** `SHELL_SCROLLBACK_DEFAULT = 2000`,
   `SHELL_SCROLLBACK_CHOICES`, `AGENT_SCROLLBACK_ROWS = 5000`,
   `shellScrollbackRows(v)` (default and clamp), and
   `scrollbackRowsFor(kind, setting)`.
2. **`components/terminal/TerminalView.tsx`.**
   - Subscribe to `s.settings?.shell_scrollback_rows`.
   - `scrollbackRef` is read in `buildTerm` instead of `5000`.
   - A separate `useEffect([rows])` sets `term.options.scrollback`.
   - Comment: this is not a spawn dep.
3. **`src/types/index.ts`** gets the field. **`src-tauri/src/schema/settings.rs`**
   gets the named `Option<u32>` field and a round-trip test, after the
   `sleep_tabs_after_min` one.
4. **`SettingsPanel.tsx`:** a `SettingRow` + `Dropdown` beside the
   sleep-tabs row, in the same shape, added to the search list. The pill
   uses `settings.shellScrollback`.
5. i18n (5 files), `untested.ts`, and filemap: the `TerminalView` row and a
   row for the new module.

Acceptance:
- A settings change leaves `pty_spawn`/`pty_kill` and `terminalSpawnKey`
  untouched.
- `npm run backend:stale` is run and reported. An old backend carries the
  key in `Settings.extra`, so nothing breaks.

Tests:
- `src/__tests__/terminal/Scrollback.test.ts`: default, clamp and per kind.
- `src/__tests__/terminal/TerminalScrollback.test.tsx` (xterm mock as in
  `TerminalSleepWake.test.tsx`): a shell builds with 2,000 and an agent with
  5,000; changing the setting updates `options.scrollback` live with no
  `pty_kill`/`pty_spawn` invoke.
- Rust: `shell_scrollback_rows_defaults_absent_and_round_trips`.

### Step 3 — Experimental flags off unless set (0.75 d)

1. **`src/lib/experimental.ts`.**
   - `experimentalEnabled` → `settings?.[flag] ?? false`.
   - Rewrite the module header.
   - Add `explicitExperimentalPatch`.
2. **Apply the patch once in the main window**, after
   `useSettingsStore.load` resolves where AppShell triggers it. Skip in
   popouts.
3. **Rust.**
   - `schema/settings.rs`: `experimental()` → `flag.unwrap_or(false)`, its
     doc comment, the marker field and a round-trip test.
   - `services/copilot/policy.rs:27` and `commands/settings.rs:102-103`:
     `unwrap_or(false)`.
   - Update the tests listed above, plus a policy test that debug on with
     the flag unset gives `Disabled`.
4. **`SettingsPanel.tsx`.**
   - Reword the Debug comment (`:2060`).
   - Give the Debug toggle a help line (`settings.debugHelp`) and the pill
     `settings.debugNoExperiments`.
   - i18n: rewrite `settings.experimentalHelp1`/`2` and delete
     `settings.experimentalHelpBold` from all 5 dictionaries.
5. **Docs.** `docs/guide/features.md:341-345`, and the filemap row for
   `lib/experimental.ts` (`:373`).

Acceptance:
- With `{ debug: true }` and the marker set, no experimental entry point
  renders.
- With `{ debug: true }` and no marker, the first load writes explicit
  `true`s for everything except `terminal_webgl`, and open browser tabs
  survive.

Tests:
- The rewritten frontend and Rust tests above.
- `src/__tests__/shell/ExperimentalExplicit.test.ts`:
  - debug + unset → patch with all but webgl, plus the marker;
  - debug off → marker only;
  - marker set → null;
  - an explicit `false` is never overwritten;
  - the popout skips it.

## i18n keys (English in `src/lib/i18n.ts`; de/es/fr/it dictionaries)

New:
- `tabCost.label` ("Memory")
- `tabCost.terminal` ("≈ {size} · {rows} of {cap} lines")
- `tabCost.terminalAsleep` ("Unloaded — the program keeps running")
- `tabCost.terminalUnbuilt` ("Not drawn yet")
- `tabCost.pdf` ("≈ {size} · {pages} pages, {file} file")
- `tabCost.unloaded` ("Unloaded — reloads when shown")
- `settings.tabCosts`, `settings.tabCostsHelp`, `settings.tabCostsRefresh`,
  `settings.tabCostsShow`, `settings.tabCostsClose`,
  `settings.tabCostsEmpty`, `settings.tabCostsOthers` ("{n} more tabs hold
  nothing loaded"), `settings.tabCostsPdfCount`
- `pdfWarn.toast` ("{n} PDFs are loaded at once.\nHidden ones unload after
  5 min — Settings › Performance shows what each tab holds.")
- `settings.shellScrollback`, `settings.shellScrollbackHelp`,
  `settings.shellScrollbackLines`
- `settings.debugHelp`

Changed: `settings.experimentalHelp1`, `settings.experimentalHelp2`.

Removed: `settings.experimentalHelpBold`.

## UntestedTag ids (`src/lib/untested.ts`)

- `tabCost.hover`: the hover-card Memory row.
- `settings.tabCosts`: the list. Its `what` also covers the PDF toast, which
  cannot carry a pill.
- `settings.shellScrollback`
- `settings.debugNoExperiments`: on the Debug toggle; covers the new rule
  and the migration.

## QA rows (`todo/group-u-performance.md`, after 2413)

Every 🖐️ box gets the four platform ✅/❌ child pairs (Linux (X11),
Linux (Wayland), Windows, macOS), as in 2408.

- **2414. Per-tab cost readout and the loaded-PDF notice.**
  - 🤖 the Step 1 tests.
  - 🖐️ Hover a busy shell tab: Memory shows "≈ … · N of 2,000 lines".
    Hover a PDF: pages and file size. Hover a PDF hidden for more than
    5 min: "Unloaded".
  - 🖐️ Settings → Performance → "What open tabs hold": largest first.
    Show jumps to the tab and closes Settings. Close closes it. Refresh
    updates.
  - 🖐️ More than 2 min after start, open 8 PDFs one after another: one
    toast at the 8th, none at the 9th. Close down to 5 and open three
    again: the toast shows once more.
- **2415. Shell scrollback setting.**
  - 🤖 the Step 2 tests.
  - 🖐️ A new shell keeps 2,000 lines (`seq 1 5000`, scroll to the top:
    3001). An agent tab still keeps 5,000. Set 1,000: the open shell trims
    at once, with no restart. Reopen Settings: 1,000.
- **2416. Experimental features no longer follow Debug mode.**
  - 🤖 the Step 3 tests.
  - 🖐️ With Debug on before updating: after the update, the same
    experiments are still on and ticked, and browser tabs are still open.
    Untick Mail: it goes away and Debug mode does not bring it back.
  - 🖐️ On a profile with Debug off, turning Debug on shows no experiment.

## Agent steps

| Agent step | Plan step | Est. | Main files |
|---|---|---|---|
| T1 cost readout + PDF notice | Step 1 | 1.25 d | new `lib/tabCost.ts`, `embed/pdf/PdfViewer.tsx` (two hunks), `tabs/TabHoverCard.tsx`, new `TabCostList.tsx` + `PdfLoadWarningHost.tsx`, `SettingsPanel.tsx`/`AppShell.tsx` (mount hunks), i18n ×5, `untested.ts` |
| T2 shell scrollback | Step 2 | 0.5 d | `terminal/TerminalView.tsx`, new `lib/terminal/scrollback.ts`, `schema/settings.rs`, `SettingsPanel.tsx`, `types/index.ts`, i18n ×5 |
| T3 experimental default | Step 3 | 0.75 d | `lib/experimental.ts`, `schema/settings.rs`, `copilot/policy.rs`, `commands/settings.rs`, `browser.rs` (test), `SettingsPanel.tsx`, `AppShell.tsx` or `stores/settings.ts` (one call), tests, i18n ×5 |

- **Run them in order.** All three touch `SettingsPanel.tsx` and the i18n
  dictionaries, and T2/T3 both touch `schema/settings.rs`.
- **Each step ends with:** green gates (AGENTS.md), one commit, a fresh
  bugs-only reviewer, and the QA row added. T2 and T3 also need
  `npm run backend:stale`, run and reported.

## Flagged for the user (not blocking)

- **Decided (user, 2026-10-10): keep them, once.** The one-shot migration
  turns today's Debug-mode experiments into explicit ticks; the user unticks
  what they don't use.
- **The warning threshold (8) and the 2-min start-up grace are constants.**
  Say if you want them as settings.
