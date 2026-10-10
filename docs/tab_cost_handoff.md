# Tab cost plan — handoff

Plan: `docs/tab_cost_plan.md`. Branch `perf` (worktree
`.claude/worktrees/perf`). Nothing here was run live.

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
