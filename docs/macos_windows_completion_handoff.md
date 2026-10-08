# macOS / Windows completion — handoff

Plan: `docs/macos_windows_completion_plan.md`. One section per agent step,
written by the implementer and amended by the reviewer. Newest at the bottom.

## Baseline (develop a6ed2c7a, 2026-10-07)

- Worktree: `.claude/worktrees/osfix-a1`, branch `osfix/a1`.
- Test counts: (filled by the main agent from the baseline runs)

## Flagged for user

(design doubts and anything a reviewer would not fix in code)

## A1 — 3.1 + 3.2

Commit: the one that carries this section — `git log -1 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a1` (one commit for the step).

Per file:
- `src/components/files/FileTree.tsx` — rename retarget derives the new path as
  `resolvePath(dirname(oldAbs), nextName)` (keeps `C:\` roots and the entry's
  separator style).
- `src/stores/tabs.ts` — `retargetTabs` compares with `relativePathWithin`
  (both separators, segment boundaries, case-insensitive on Windows) and
  prefix-swaps with `resolvePath`; labels via `basename`.
- `src/components/monitoring/DiskUsagePane.tsx` — `parentDir` is
  `dirname(path) || "/"` (now exported for the test); picked-folder label via
  `basename`.
- `src/components/files/RenameDialog.tsx` — `containingFolderLabel` is
  `basename(dirname(absPath)) || rootLabel`.
- `src/components/embed/deck/DeckView.tsx` — three `.split("/").pop()` labels
  → `basename(x) || x` (lines 952/1045/1185 of the base).
- `src/components/embed/deck/DeckPresenter.tsx` — stale "Linux-only … TODO V
  #121" comment replaced by what `presenter.rs` does per OS.
- `src/lib/terminal/pythonRun.ts` — `currentPlatform()` = `IS_WINDOWS ?
  "windows" : "unix"` from `lib/platform`.
- `src/lib/terminal/shellScriptRun.ts` — `shellRunCommand` quotes with
  `pythonRun.shellQuote(scriptRel, "windows")` for `powershell`/`cmd`, `'…'`
  (same helper, `"unix"`) for the POSIX shells; the exported `shellQuote`
  (used by `DevBuildIndicator`) is unchanged in behaviour.
- `src/lib/terminal/pathLinks.ts` — `PATH_SHAPE` takes `[\\/]` separators
  and an optional `[A-Za-z]:` drive root; `//`/`\\` rejection via
  `DOUBLE_SEP`; leaf via `basename`; `EXTENSION` excludes `\` as well.
- `src/__tests__/run/ShellScriptRun.test.ts` — the two expectations that
  codified `'…'` for PowerShell/cmd fixed; `C:\p\run.bat`, `""` doubling and a
  Windows-root `shellScriptRunPlan` case added.
- `src/__tests__/files/WindowsPaths.test.ts` (new) — `containingFolderLabel`,
  `parentDir`, the FileTree composition, `retargetTabs` with `C:\p\a.txt` →
  `C:\p\b.txt`, a directory rename, `subway`-vs-`sub` boundary, case folding.
- `src/__tests__/terminal/PathLinks.test.tsx` — Windows shapes added; the
  existing POSIX fixtures are untouched and still pass.
- `todo/group-h-crossplatform.md` — 🖐️ entry 32p with the four platform
  children (§1 rule), under the 2026-09-03 sweep.

Choices where the plan left room:
- A bare leading `\` is **not** a path root in `PATH_SHAPE` (`\section`,
  `\textbf` would otherwise go to the backend on every TeX line). `C:\…`,
  `.\…`, `..\…` and `a\b` are. UNC `\\server\share` is rejected like `//`.
- The "candidates are `normalizePath`ed before `relativePathWithin`" bullet
  needed no code: `relativePathWithin`/`isPathWithin` already normalize both
  sides internally, and the only paths that reach them in `pathLinks.ts` are
  the backend's `entry.path`.
- Backend `resolve_text_paths` (`fs.rs:153`): read-verified, no change.
  `Path::new(candidate)` parses `\` and drive prefixes on Windows;
  `normalize_lexical` folds `.\`; a `\`-rooted candidate without a drive
  joins to the base's drive and then fails `strip_prefix` → `None`. On Linux a
  `\` is a filename byte, so a stray candidate just does not exist.
- `parentDir` was exported from `DiskUsagePane.tsx` (same pattern as
  `RenameDialog.containingFolderLabel`) rather than moved: decision 2 forbids
  new path helpers.
- No `UntestedTag` pill: nothing new is rendered; the 🖐️ todo line carries
  the verification.

Gotchas:
- `normalizePath("C:/p/x")` emits `C:\p\x` by design (drive ⇒ `\`), so do
  not assert forward-slash drive paths survive; the backend never emits them.
- `DevBuildIndicator.tsx` imports `shellQuote` from `shellScriptRun` — keep
  that export POSIX (A2 touches that file).
- Lint warning line numbers in `DiskUsagePane.tsx`/`DeckView.tsx` shift by one
  (one import line each); the warning set is identical (28 → 28).

Gates (worktree, 2026-10-07):
| Gate | Result |
|---|---|
| `npm run build` | green (tsc + both bundles) |
| `npm test` | 729 files / 7519 tests passed (baseline 728 / 7507) |
| `npm run lint` | 0 errors, 28 warnings before and after (same set) |
| `scripts/brand-check.sh` | pass |
| `git diff --check` | clean |
| `cargo test` / `cargo clippy` | not run: no `src-tauri/` change in this step (read-only check of `fs.rs`) |

### Reviewer

Verified by feeding the brief's inputs through a throwaway vitest probe
(deleted; nothing launched):
- `retargetTabs`: `C:\p\a.txt` → `C:\p\b.txt` (path + label), `C:\p\dir`
  → `C:\p\dir2` with a tab at `C:\p\dir\x.md` (and one already at
  `C:\p\dir2\y.md`, untouched), `/p/a` → `/p/b`, `/p/dir` → `/p/dir2` with
  `/p/dir2/x` **not** retargeted (segment boundary), `/p/Dir/y` untouched on
  POSIX (case stays significant). All correct.
- `pathLinks.ts`: the six existing POSIX fixture lines give byte-identical
  candidate lists; `\section{x}`, `\textbf`, `\\server\share\x.md`, `a//b.md`,
  `a\\b.md`, `C:\`, `D:` yield no candidate; `\includegraphics{fig/a.pdf}`
  still yields `fig/a.pdf` as before. New on POSIX: a single-letter
  `h:/x.txt` is now a candidate (drive root by design) — harmless, the backend
  lookup decides what links.
- `shellRunCommand`: `cmd /c "C:\p dir\run.bat" x "y"` (args verbatim, as
  documented), `powershell -File "scripts/a b.ps1" -N 1`, POSIX unchanged
  (`bash 'a b.sh' x`, `zsh 'it'\''s.sh'`).
- `parentDir`: `C:\a` → `C:\`, `/a` → `/`, `/` → `/`, `C:\` → `/` (same as
  before the step; unreachable — the only caller passes `node.is_dir ?
  node.path : parentDir(node.path)`, so a root never reaches it).
- Imports: no new cycle (`shellScriptRun` → `pythonRun` → `stores/tabs`;
  `tabs.ts` imports neither); `FileTree.tsx` already imported
  `dirname`/`resolvePath`.

Fixed (one commit, this one): `retargetTabs` turned a POSIX tab path holding
a `\` into `/`-joined segments — `/p/dir/we\ird.md` under a `/p/dir` →
`/p/dir2` rename became `/p/dir2/we/ird.md` (the old prefix-swap kept it; a
`\` is a legal byte in a Linux file name and `relativePathWithin` reads any
`\` as a separator). An exact-prefix match (`oldAbs` + `/` or `\`) now keeps
the tail byte-for-byte; only a case-folded or mixed-separator match goes
through `resolvePath`. Regression test in
`src/__tests__/files/FileTabSync.test.ts` (also pins `/p/sub2` ∉ `/p/sub`).

Gates (worktree, after the fix):
| Gate | Result |
|---|---|
| `npm run build` | green |
| `npm test` | 729 files / 7520 tests passed |
| `npm run lint` | 0 errors, 28 warnings (same set) |
| `scripts/brand-check.sh` | pass |
| `git diff --check` | clean |
| `cargo test` / `cargo clippy` | not run: no `src-tauri/` change |

Fixed (second commit, on the coordinator's call): `cmd /c "scripts/run.bat"`
(forward slash, no space) — cmd's `/c` rule strips the outer quotes when the
quoted string has no whitespace and then tokenises `scripts/run.bat` at the
`/` ("'scripts' is not recognized …", the npm-on-cmd gotcha); a PowerShell
tab drops the quotes the same way. `shellRunCommand` now converts the
project-relative `scriptRel`'s `/` to `\` for the `cmd`/`powershell`
interpreters only (`scriptRel` in the plan stays `/`, the POSIX branch is
untouched). Regression test in `src/__tests__/run/ShellScriptRun.test.ts`
(`scripts/run.bat` → `cmd /c "scripts\run.bat"`, `tools/a.ps1` →
`powershell -File "tools\a.ps1"`, POSIX `/` kept). Still owed the 32p
manual test on Windows.

### Flagged for user

- `relativePathWithin`/`isPathWithin` (shared helpers, not this step) read any
  `\` as a Windows separator; FileTree and other callers inherit the same
  blind spot for POSIX names containing `\`. Only `retargetTabs` is fixed
  here (it had a byte-exact predecessor); the rest is pre-existing.

## A2 — 3.3

Commit: the one that carries this section — `git log -1 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a2` (one commit for the step).

Per file:
- `src/lib/shortcuts/shortcuts.ts` — `modifierLabel()` (⌘ on mac, Ctrl
  elsewhere), lifted from `FileViewerPane`'s `OPEN_MODIFIER`; the one label for
  mouse-modifier prose. Key chords keep going through `useChordHint`.
- `src/lib/i18n.ts` + `src/lib/i18nDicts/{de,es,fr,it}.ts` — 38 keys per file:
  19 tooltip keys lose their literal `(Ctrl+…)`/`(Strg+…)`/`(Alt+←)` suffix
  (the chord is appended by `useChordHint` → `shortcut.hint`); 14 prose keys
  carry `{modifier}` where they said `Ctrl+`/`Strg+` (`mail.selectHint` keeps
  its hyphen: `{modifier}-click`); 3 autocomplete strings carry `{altRight}`
  (and the two editor legends `{altBrackets}`); `sysmon.linuxOnly` →
  `sysmon.unavailable` ("not available on this system"); `settings.copilotUnsupported`
  loses "for now".
- `src/components/embed/FileViewerPane.tsx` — `OPEN_MODIFIER` → `modifierLabel()`;
  `AC_KEY_LABELS` (module const, via `chordLabel`) feeds the ghost-text legend;
  `useChordHint` in `CodeEditor`, `SaveButton`, `UndoRedoButtons`,
  `EditorAiControls`, `FontSizeControls` — rebindable ones by action id
  (`editorReplace`, `editorSave`, `editorUndo`, `editorRedo`,
  `editorAutocomplete`, `zoomOut`/`zoomReset`/`zoomIn`), Replace-all as the
  literal `Ctrl+Enter`; `syncNoPdfMsg` gets `{modifier}`.
- `src/components/embed/pdf/PdfViewer.tsx` — `PdfCanvas` tooltips (Go to page,
  Find, Undo, Redo, Save, Print, link Back) as literal descriptors; the handler
  (`e.ctrlKey || e.metaKey`, `e.altKey`) is unchanged.
- `src/components/embed/deck/DeckView.tsx` — Duplicate tooltip, literal `Ctrl+D`.
- `src/components/agents/AgentSchedulesView.tsx` — composer Send tooltip,
  literal `Ctrl+Enter`.
- `src/components/agents/PromptChart.tsx`, `layout/SettingsPanel.tsx`,
  `layout/SettingsSubPanels.tsx`, `layout/SteeringLegend.tsx`,
  `layout/ShortcutHelpOverlay.tsx`, `layout/intro/LocalModelsPage.tsx`,
  `terminal/TerminalPromptStrip.tsx`, `mail/MailList.tsx` — pass
  `{ modifier: modifierLabel() }` (LocalModelsPage also `altRight`).
- `src/lib/lessons.ts` — `bodyParams: () => ({ modifier: modifierLabel() })` on
  the four lesson steps whose body names the modifier (the existing `TourStep`
  hook, previously used only by the focus-mode tip).
- `src/components/monitoring/SystemMonitorPane.tsx` — key rename.
- `src/components/header/DevBuildIndicator.tsx` — "Open log" button hidden
  when `IS_WINDOWS` (`followLog` itself untouched).
- `src-tauri/src/commands/monitor.rs` — doc comment: `supported: false` on every
  non-Linux target, placeholder wording.
- `src/__tests__/shell/Shortcuts.test.ts` — `modifierLabel` off mac; `chordLabel`
  + `modifierLabel` under mocked `lib/platform` for macos / windows / linux
  (`vi.doMock` + fresh import, same pattern as `PanelToggleCopy.test.tsx`).
- `docs/filemap_frontend.md` — `shortcuts.ts` row mentions `modifierLabel()`.

Choices where the plan left room:
- Tooltips of the editor's rebindable chords use the action id, so a rebinding
  shows in the title; text size uses `zoomOut`/`zoomReset`/`zoomIn` because
  that is what `zoomFor` matches in the editor keydown.
- `fileViewer.autocompleteOnHint` moved its chord to the end ("… — click to
  disable (Ctrl+Space)") since `shortcut.hint` is `{label} ({chord})`.
- The "Ctrl+Shift+Tab cycles …" / "Ctrl+Shift+R" / "Ctrl+1–9" prose takes
  `{modifier}` as the plan says, not the resolved chord: on mac it reads
  "⌘+Shift+Tab" (prose), while tooltips render the glyph form "⇧⌘Tab".
- Autocomplete ⌥: the legend's `Alt+→` / `Alt+[/]` are `chordLabel` output
  (`⌥→`, `⌥[/]` on mac) rather than a second label helper; `intro.models.step6Body`
  gets the same `{altRight}`.
- `pdfLinks.backTitle` (Alt+←) and `mail.selectHint` (Ctrl-click, hyphen —
  the plan's `Ctrl\+` sweep missed it) were swept too: same handlers, same rule.
- Left literal on purpose: `mobile.keys.interruptConfirm` and
  `lessons.runPython.runFileBody` (terminal Ctrl+C is a control character, not
  a chord), `mobile.mode.yoloGeminiHint` (Gemini's own Ctrl+Y).
- German dictionaries now show "Ctrl" where they said "Strg" in these strings,
  as `fileViewer.linkOpenHint` and `chordLabel` already did.
- No `UntestedTag`, no 🖐️ line: wording only, no new control (§3.3 names none).
- `src-tauri/src/sysstat.rs:83` still says "Linux only" in a doc comment — left
  for A7 (3.10 edits that file).

Gotchas:
- `IS_MAC`/`IS_WINDOWS` are import-time constants: the per-platform test must
  `vi.resetModules()` + `vi.doMock("../../lib/platform")` + dynamic import.
- `vitest` prints `translate()` output per key only if `shortcut.hint` holds
  `{label} ({chord})` — a dictionary that drops the parenthesis would change
  every tooltip at once.
- Windows `cargo check` cross-check not run: the only `src-tauri/` change is a
  doc comment.

Gates (worktree, 2026-10-07):
| Gate | Result |
|---|---|
| `npm run build` | green (tsc + both bundles) |
| `npm test` | 729 files / 7524 tests passed (A1 baseline 729 / 7521) |
| `npm run lint` | 0 errors, 28 warnings (same set as A1) |
| `cargo test` | 3711 passed, 3 ignored |
| `cargo clippy -D warnings` | no issues |
| `scripts/brand-check.sh` | pass (48 allowlist entries) |
| `git diff --check` | clean |

### Reviewer

Verified against the plan (§3.3), the diff `f475b244..2ddc457b` and the
tree (nothing launched):
- Keys: the 37 changed + 1 removed key (`sysmon.linuxOnly`) exist in
  `i18n.ts` and all four `i18nDicts/{de,es,fr,it}.ts`; the `{…}` placeholder
  set of every key is identical in the five files; no dictionary has a
  duplicate key; no translation collapsed into the English string (old
  translation ≠ old English ⇒ new translation ≠ new English, all 4 × 37);
  `rg -n "sysmon.linuxOnly"` hits only the plan and this handoff.
- Consumers: every `{modifier}` / `{altRight}` / `{altBrackets}` key is
  filled at each call site (`rg` per key over `src/` and `mobile-web/src/`;
  the steering `descKey` has two readers — `ShortcutHelpOverlay`,
  `SteeringLegend` — both pass `modifier`; the four lessons fill it through
  `TourStep.bodyParams`, read by `TourHost.tsx:313`); no consumer of a
  removed key remains; `mobile-web` uses none of the 38.
- `useChordHint`: all eight action ids (`editorReplace`, `editorSave`,
  `editorUndo`, `editorRedo`, `editorAutocomplete`, `zoomIn`, `zoomOut`,
  `zoomReset`) are in `ShortcutAction` and the defaults table; every call is
  at a component's top level (`CodeEditor`, `SaveButton`, `UndoRedoButtons`,
  `EditorAiControls`, `FontSizeControls`, `PdfCanvas`, `DeckView`,
  `AgentTabComposer`), none conditional or in a loop. Each literal
  descriptor matches its handler: PDF `onHostKeyDown` (`f`, `g`, `s`, `p`,
  `z`, `⇧z`, `Alt+←`, `PdfViewer.tsx:3491–3524`), deck `mod && "d"`
  (`DeckView.tsx:1348`), replace-all `ctrl|meta + Enter`
  (`FileViewerPane.tsx:4144`), composer Send `ctrl|meta + Enter`.
- `modifierLabel()` / `chordLabel`: the new mocked-platform test gives `⌘`,
  `⇧⌘Tab`, `⌘S`, `⌥→` on macOS and `Ctrl`, `Ctrl+Shift+Tab`, `Ctrl+S`,
  `Alt+→` on Windows/Linux; read the 14 prose strings with `⌘` substituted in
  all five languages (`⌘+Shift+Tab`, `⌘+1–9`, `⌘+click` / `⌘-click`, `⌘+C`,
  `⌘+Space`, `⌘+D`) — all read correctly. `IS_MAC` stays imported in
  `FileViewerPane` (two other uses); `shortcuts.ts` gains no import, so
  `lessons.ts → shortcuts.ts` opens no cycle.
- `DevBuildIndicator`: only the "Open log" `<button>` is inside
  `!IS_WINDOWS`; the chip, the relaunch, pause and build-now buttons and the
  rest of the card render unchanged on Windows (`DevBuildIndicator.tsx:355–397`).
- No new `any`; no `UntestedTag` owed (no new control). Rust change is a doc
  comment only.
- Lint set: 28 warnings, all `react-hooks/exhaustive-deps`; the five in
  A2-touched files (`DeckView` ×3, `PdfViewer`, `SystemMonitorPane`) name
  `t`, `viewPos.initial`, `globalMachine` — pre-existing; A2 touched no hook
  in those files and no warning names `chordHint`/`modifierLabel`.

Fixed: none.

Gates (worktree, 2026-10-07, nothing changed in code):
| Gate | Result |
|---|---|
| `npm test` | 729 files / 7524 tests passed |
| `npm run lint` | 0 errors, 28 warnings (same set, see above) |
| `scripts/brand-check.sh` | pass (48 allowlist entries) |
| `git diff --check` | clean |
| `npm run build` / `cargo *` | not re-run: no code change since the implementer's green run |

### Flagged for user

- `TableView` hosts the shared `SaveButton` / `UndoRedoButtons`, whose
  tooltips now render the rebindable `editorSave` / `editorUndo` /
  `editorRedo` chords, but `TableView.onKeyDown` (`TableView.tsx:611–626`)
  hardcodes Ctrl/⌘+S, Z, Shift+Z, Y. At the defaults the labels are right;
  after a rebind the table's tooltip names a chord the table ignores.
  Pre-existing gap (the table never honoured those actions) — either route
  its keydown through `actionMatches` or pass it literal titles. Not changed.
- `fileViewer.redoShortcut` now shows redo's default `Ctrl+Y` where the old
  literal said `Ctrl+Shift+Z`; both chords work (`actionChords` keeps the
  Shift+Z alternate). Wording only.
- Prose outside the `Ctrl+` sweep still names Alt textually on macOS:
  `lessons.keyboardSteering.projectCycleBody` ("Alt+Shift+←"); `Ctrl+C` /
  `Ctrl+Y` in `mobile.keys.interruptConfirm`, `lessons.runPython.runFileBody`,
  `mobile.mode.yoloGeminiHint` are left literal by the implementer's recorded
  rule. Not changed.

## A3 — 3.4

Commit: `b2401088` (the step) + the reviewer's fix commit that carries this section's `### Reviewer` (`git log -2 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a3`).

Per file:
- `src-tauri/src/services/mobile_control/discovery.rs` — `TERMINALS_TMUX` /
  `TERMINALS_UNSUPPORTED`, pure `terminals_support_on(windows)` and
  `terminals_support()` (= `_on(cfg!(target_os = "windows"))`), next to
  `shells_open`; `live_tmux` now short-circuits on `terminals_support()`
  instead of its own `cfg!`, so the field and the empty session list cannot
  drift. Test `terminals_support_names_tmux_or_unsupported` (both values,
  the host's own answer, a `json!` row carrying each, and on a Windows build
  that `live_tmux()` is `Ok(empty)`).
- `src-tauri/src/services/mobile_control/host.rs` — project-detail `json!`
  gains `"terminals": terminals_support()` beside `"shells"`; the headless
  detail test (`a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner`)
  asserts the field equals `terminals_support()` and the literal for this OS.
- `mobile-web/src/api.ts` — `ProjectDetail.terminals?: "tmux" | "unsupported"`
  (absent ⇒ tmux, documented on the field).
- `mobile-web/src/screens/Project.tsx` — `terminalsOffered =
  detail?.terminals !== "unsupported"`; the header ＋ stays (named "Send a
  file from this phone" when off) and hands the sheet `creates`; gates each
  agent card's ◷, the Prompts sheet's `onSchedule` and `markupNewTab` (which is
  also what `ProjectFiles.showTab` and both `OutboxViewer`s' `newTab` read,
  so Mark up's new-tab Submit goes with it); one `.notice` line
  (`mobile.project.terminalsUnsupported` + its pill) under the
  desktop-unavailable notice.
- `mobile-web/src/screens/NewTabSheet.tsx` (reviewer) — `creates?: boolean`
  (default true): when false the sheet is its send-a-file row alone under
  that title — no shell, agent, worktree, local, cloud, sign-in or
  needs-window rows, no "Opens in …" note, and `launch-options` is not
  fetched.
- `mobile-web/src/screens/PromptsSheet.tsx` — `onSchedule` optional; the
  Schedule… button renders only when it is given (Send now, Edit, Delete and
  the form stay: collected prompts are files).
- `src/lib/i18n.ts` + `src/lib/i18nDicts/{de,es,fr,it}.ts` — one key,
  `mobile.project.terminalsUnsupported`, after `mobile.project.newTabTitle`.
- `src/lib/untested.ts` — row `mobile.project.terminalsUnsupported`.
- `todo/group-h-crossplatform.md` — under 32z's "Phone-side 'no terminals on
  Windows' copy": a built-on line, the ticked 🤖 line naming the three tests,
  the 🖐️ line with the four ✅/❌ platform pairs (none ticked); the 32z entry
  itself stays unticked.
- `src/__tests__/mobile/MobileProjectTerminalsUnsupported.test.tsx` (new) —
  `terminals: "unsupported"` (with `shells: true`): the ＋ is named "Send a
  file from this phone", its sheet holds Close and that row only (no `New
  shell`, no `Claude Code`, no note) and `launch-options` is never fetched;
  no ◷ (`Scheduled prompts for Claude`), the Prompts sheet lists a prompt with Send now but no Schedule…,
  the line is shown; a gallery picture opened through the name menu's 🖼 has
  Save but no Mark up; field absent and `"tmux"`: ＋, ◷ and Mark up present,
  no line.
- `docs/filemap_backend.md` — `mobile_control/` row names the field and its
  predicate (no frontend row exists for `screens/Project.tsx`; none added).

Choices where the plan left room:
- "Held-prompt sending" on the phone is reached two ways: the Terminal
  composer's `holdDraft` (behind `connected`, i.e. a live PTY bridge, which a
  tab with no tmux session never has — `tab.available` is false, the card's
  Open is disabled) and the project screen's markup new-tab Submit, which
  `/held`s the prompt into the tab it opens. The second is the reachable one
  and is hidden through `markupNewTab`; `Terminal.tsx` is untouched (nothing
  to gate that is not already behind the connection).
- The Prompts sheet's Schedule… is hidden too (it opens the same
  `ScheduleSheet` as a card's ◷); the sheet itself stays — collected prompts
  are the host's files and a Send now still goes through the desktop.
- The ＋ sheet's "Send a file" row stays on a tmux-less host (reviewer fix
  below): the project inbox is a file the sidecar writes, no tab involved.
- `TERMINALS_*` are string constants rather than an enum: the field is one
  `json!` literal on the way out and the phone's union type on the way in;
  `terminals_support_on(bool)` is the cfg-free core decision 4 asks for.
- The pill sits on the notice line itself (id = the line's key), as
  `mobile.headless.tabs` does on the desktop-unavailable notice.

Gotchas:
- `OutboxViewer`'s Mark up button is labelled `Mark up <file>`
  (`mobile.markup.openFile`), and the Prompts sheet's Send now carries an
  `aria-label` with the prompt text — query by `/^Mark up/` and by text.
- `npm run mobile:bundle` writes `mobile-dist/` (untracked, `emptyOutDir`);
  nothing under `src-tauri/` changes — nothing to commit from it.

Gates (worktree, 2026-10-07):
| Gate | Result |
|---|---|
| `npm run build` | green (tsc + both bundles) |
| `npm test` | 730 files / 7527 tests passed (A2 baseline 729 / 7524) |
| `cargo test` | 3712 passed, 3 ignored (A2 baseline 3711) |
| `npm run lint` | 0 errors, 28 warnings (same set as A2) |
| `cargo clippy -D warnings` | no issues |
| `scripts/brand-check.sh` | pass (48 allowlist entries) |
| `npm run mobile:bundle` | green |
| `git diff --check` | clean |
| Windows `cargo check --target x86_64-pc-windows-msvc` | green (shims) |

### Reviewer

Verified (read against the tree, tests run):
- `terminals_support_on(false) == "tmux"`, `(true) == "unsupported"`;
  `live_tmux`'s short-circuit is `terminals_support() == TERMINALS_UNSUPPORTED`,
  which is the same `cfg!(target_os = "windows")` it tested before — the
  Linux path is unchanged (`discovery.rs:828`).
- The project detail is one `json!` in `host::project` (`host.rs:1157–1166`)
  shared by the windowed and the headless branch (the `match` on
  `desktop_call` only fills the rows; `rg '"shells"' mobile_control` has no
  second builder), so both answers carry `terminals`; the headless test
  asserts it.
- The phone with `"unsupported"` gates exactly: ＋ sheet create rows (after
  the fix), per-card ◷, Prompts sheet Schedule…, `markupNewTab` (gallery /
  files Mark up → new-tab Submit). With `"tmux"` or the field absent the
  screen renders as before (test's third case: ＋ `New tab`, ◷, Mark up
  present, no line).
- `mobile.project.terminalsUnsupported` is in en/de/es/fr/it; i18n parity
  test green; `src/lib/untested.ts` row id equals the pill id; the todo
  lines follow §1/§7's shape (🤖 ticked naming the tests, 🖐️ with the four
  ✅/❌ pairs, none ticked, 32z itself unticked).
- The browser API gained only the literal `"tmux" | "unsupported"`; no id,
  path or tmux target.

Fixed (user-visible regression, decided by the main agent):
- On an `unsupported` host the ＋ stays reachable with only its "Send a file
  from this phone" row — `NewTabSheet` `creates` prop, the ＋ and the sheet
  titled after that row (existing `mobile.projectInbox.send` key, no new
  i18n); regression case in `MobileProjectTerminalsUnsupported.test.tsx`.
  Register row and todo lines reworded to match. Sha: see the commit that
  carries this section.

Gates after the fix (worktree, 2026-10-07): `npm run build` green; `npm test`
730 files / 7527 tests; `cargo test` 3712 passed, 3 ignored; `npm run lint`
0 errors / 28 warnings; `cargo clippy -D warnings` clean;
`scripts/brand-check.sh` pass (48); `npm run mobile:bundle` green;
`git diff --check` clean. No Rust changed, so the Windows `cargo check`
cross-check from the step stands.

### Flagged for user

- The 32z backlog entry itself is left unticked as the plan says; the
  automated line under it is ticked.
- Doubtful, not fixed: on a Windows host the detail still says
  `shells: true` when the desktop's `shell_tabs` switch is on; the phone no
  longer offers a shell there (the sheet's create rows are behind `creates`),
  so the flag is merely redundant, but a future reader of `shells` alone
  would be misled. Could be `shells_open(..) && terminals_support() == TERMINALS_TMUX`.
- Design, not fixed: `Terminal.tsx`'s held-prompt composer is untouched by
  the step (recorded choice: it sits behind `connected`, which a tab with no
  tmux session never reaches). If the Terminal screen ever opens on such a
  host by another route, the held path would need its own gate.

## A4 — 3.5

Commit: the one that carries this section — `git log -1 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a4` (one commit for the step).

Per file:
- `scripts/tabtivity-send.ps1` — rewritten against the sh twin line by line
  (84 → 195 lines): the four-line usage (`--help` line added); the sh
  `case` as a `switch -CaseSensitive` with the sh's own exit-2 messages
  (`Use --clear alone.`, `Use -n NAME for stdin.`, `Name at least one file.`,
  `Unknown option; use --help.`); `The project directory is unavailable.`
  split out of the root check; the `.send-lock` directory as the mutex
  (a fresh `.send-<guid>` directory `[IO.Directory]::Move`d onto
  `.send-lock` — the rename fails when the lock exists, so it is the sh
  `mkdir`'s atomic twin; exit 5 + the sh message, removed in the outer `finally`,
  which `exit`/`Fail` inside the `try` also reaches); `--clear` and the
  1 GiB sum share one `OutboxFiles` (regular, non-reparse files; the sum
  skips the current stage file, which the sh keeps in a subdirectory);
  `OriginOf` = `GetFullPath` with the `$root\` prefix stripped
  (ordinal, case-insensitive), `\` → `/`, empty outside the project or under
  `.tabtivity/`; the leaf loop also checks `.<leaf>.src` and writes it after
  `.tab`, both deleted when the publish fails; `KindOf` reads the first
  4096 bytes with a `FileStream`, takes the magic from `[BitConverter]::ToString`
  (PNG/JPEG/GIF87a/GIF89a/RIFF…WEBP → `shown as an image`, `%PDF-` →
  `opens as a PDF`) and runs the sh `awk` UTF-8 machine verbatim
  (`shown as text` / `offered as a download`); the report line is the sh's
  `→ phone: <leaf> (<n> KB) — <kind>` with `[char]0x2192`/`0x2014` so the
  file stays ASCII (no BOM needed for Windows PowerShell 5.1).
- `scripts/install_phone.sh` — the `jq is required` gate becomes a parser
  choice: `python3 -I` when present (`mobile_setting KEY DEFAULT`,
  `serve_mapped AUTHORITY NEEDLE PORT < json`), else the same two reads as
  `jq` functions, else `python3 or jq is required to read JSON (brew install
  jq)`; the two call sites read through the functions. Bash 3.2: plain
  functions, `[[ =~ ]]`, no arrays/`${,,}`.
- `src-tauri/src/services/agent_bin.rs` — test
  `powershell_send_twin_matches_the_sh_leaves_caps_and_messages`: both
  scripts contain `.$leaf.tab`, `.$leaf.src`, `.send-lock`, `.send-`,
  `25165824`, `25165825`, `1073741824`, `.<slug>/`; every `fail CODE '…'`
  of the sh is `Fail CODE '…'` in the PS1 (≥ 14, codes 2–5), every
  `report='…'` is `return '…'`, and the six single-quoted literals naming
  the command (four usage lines, cleared, warning — scanned per line, since
  comments like "tab's" carry apostrophes) are quoted the same.

Choices where the plan left room:
- The PS1 keeps its stage-file + `[IO.File]::Move` publication (never
  overwrites) rather than the sh's stage directory + hard link; the plan asks
  for parity of markers, lock, caps and messages, not of the mechanism.
- Source paths resolve through
  `$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath`
  (PowerShell's own location, not the process CWD that `[IO.Path]::GetFullPath`
  uses — the old `[IO.File]::Exists($source)` had that gap).
- `-n NAME` is sanitised as given (`a/b` → `a_b`, like the sh `tr`), not
  through `GetFileName`; a file's leaf uses `GetFileName` (both separators).
- The extension split is `LastIndexOf('.')`, like the sh's `${name##*.}`,
  not `[IO.Path]::GetExtension` (which drops a trailing `.`).
- `Fail 3 'Cannot stage the file.'` and `Fail 4 'Cannot read the file.'`
  are raised at the sh's points; anything else inside the loop still falls
  to the existing `Fail 4 $_.Exception.Message`.
- `install_phone.sh`'s python parser runs with `-I` (no cwd/`PYTHON*` on the
  import path). `None`/`false` fall to the default like jq's `//`.
- No `UntestedTag`/🖐️ line: no UI; 31ad's manual phone QA already covers
  `tabtivity-send` on each platform.

Gotchas:
- PowerShell is not installed here (`command -v pwsh` empty): the PS1 is
  read-verified only. Things that could only be caught by running it:
  `[IO.Directory]::Move` refusing an existing `.send-lock` (Win32 `MoveFile`
  without `REPLACE_EXISTING`), `finally` running on `exit` (it does; `exit` is a flow-control
  exception no `catch` sees), `switch -CaseSensitive` with `$args`
  reassignment in the `'--'` arm.
- `GetFullPath` does not resolve directory symlinks/junctions, the sh's
  `pwd -P` does: a project file reached through a junction outside `$root`
  gets no origin marker on Windows (empty = gallery-only, never wrong).
- The sh `trap 'exit 4' HUP INT TERM` has no PowerShell twin; Ctrl+C runs
  the `finally` blocks (stage + lock removed) but exits with PowerShell's
  own code.
- `shellcheck` is not installed; `bash -n` only.
- `install_phone.sh` was exercised with a fake `tailscale`/state dir
  (scratchpad): python3-only PATH, jq-only PATH and neither — identical
  answers for a good mapping, a Funnel-enabled one, a port mismatch and a
  missing origin. (Re-run for the python path after the gate change below:
  good mapping and port mismatch, same answers.)

### Gates (finishing implementer, 2026-10-08)

The first implementer's session was cut off before the gates; a second one
read the diff against §3.5, ran the gates and made these changes before the
commit:
- PS1 lock: `New-Item -ItemType Directory -Path <WildcardPattern-escaped
  outbox> -Name '.send-lock'` → a `.send-<guid>` directory renamed onto
  `.send-lock`. Whether `New-Item -Path` globs differs between PowerShell
  versions, so the escape broke `[`/`]` project paths on one of 5.1/7 either
  way; the rename is pure .NET and atomic on both. This departs from §3.5's
  "created with `New-Item`" wording, not from its intent (directory mutex,
  exit 5, removed in `finally`).
- PS1: `$tab` checked with `-cnotmatch '^…{1,64}\z'` (`$` let a trailing
  newline through; case-insensitive matching let e.g. the Kelvin sign fold
  into `[A-Za-z]`), and the name sanitised with `-creplace` for the same
  reason. Non-ASCII still differs in count from the sh `tr` (one `_` per
  UTF-16 unit vs. per byte) — leaf cosmetics only.
- `install_phone.sh`: python3 is chosen by running `python3 -I -c 'import
  json'`, not `command -v` — macOS's `/usr/bin/python3` is a stub that fails
  until the Command Line Tools are installed, and jq now gets its turn then.

Results: `npm run build` ok; `npm run lint` 0 errors / 28 warnings (no TS
touched); `cargo test` 3713 passed (A3 3712 + the parity test); `cargo
clippy --all-targets -D warnings` ok; `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` ok; `git diff --check` clean; `bash -n
scripts/install_phone.sh` ok. `npm test`: 730 files / 7527 tests, **2
failed** — `src/__tests__/mobile/MobileHeldPromptStore.test.ts` (two cases),
not this step: `readHeld` ages holds against the real clock and the
fixtures' 2026-09-30 sends fell past the seven-day cutoff on 2026-10-07
(it fails alone too; this step touches no TS, so `osfix/a3` is the same). The fix (`vi.useFakeTimers({ now: NOW,
toFake: ["Date"] })` in `beforeEach`) sits uncommitted in the main checkout
from another session, so it is not duplicated here.

Flagged for user:
- The `MobileHeldPromptStore` date bomb above: red on every branch until the
  main checkout's fix lands on `develop`.
- `tabtivity-send.ps1` has never been run (no PowerShell here); first run on
  Windows is 31ad's phone QA.

### Reviewer

Read `tabtivity-send.ps1` line by line against the sh twin for PowerShell 5.1
and 7 (quoting, `$args`/`switch`, `exit` through `finally`, lock, wildcard
paths, UTF-8 machine, caps, messages), `install_phone.sh` for bash 3.2, and
the parity test. Exercised `install_phone.sh` with a fake `tailscale` and
state dir under python3-only, jq-only and neither.

Fixed (one commit, `fix(scripts): …` after f3606aca):
- `install_phone.sh`, python3 path: `tailscale serve status --json` prints
  `null` when nothing is served — exactly the not-set-up-yet case — and
  `json.load` gave `None`, so the user saw a Python traceback before the
  mapping message (jq reads `null` silently). Both python readers now take
  `json.load(…) or {}`. Regression test
  `commands::mobile_control::install_phone_script_tests::python3_and_jq_give_the_same_answers`
  (unix) runs the embedded script with a PATH of only `dirname`, the parser
  and a fake `tailscale`, for each of python3/jq that is installed: good
  mapping → origin on stdout; Funnel, `null`, `{}` → exit 1 with only the
  mapping message on stderr; settings `null`/`{}` → the origin message. On
  macOS CI this is also a bash 3.2 run.
- `tabtivity-send.ps1`: the leaf loop's `Test-Path` follows links, so a
  dangling link planted at `.<leaf>.tab`/`.<leaf>.src` read as free and
  `WriteAllText` then created the file wherever it pointed (the project
  folder is attacker-controlled; the sh checks `-e || -L` and `mv`s). A
  `Present` helper (`[IO.File]::GetAttributes`, which does not follow links)
  replaces all four `Test-Path` checks of `$dest`/`$marker`/`$origin`. The
  parity test now also asserts the sh's three `[ -L "$outbox/…" ]` checks
  and the PS1's `(Present …)` with no `Test-Path -LiteralPath` on those.

Checked, no change: `exit`/`Fail` inside `try` reaches the outer `finally`
(lock removed) and no `catch` sees it; the lock is taken before that `try`,
so a lost race never removes another send's lock; `switch -CaseSensitive`
string clauses are exact, not wildcard; `GetUnresolvedProviderPathFromPSPath`
does not glob `[`/`]`; the PS1 is pure ASCII; the stage dot-file is hidden
from the phone listing (`outbox.rs` skips dot leaves) and the `.src` is only
shape-checked there, then proved by `files::entry`; the parity test parses
17 `fail` lines, 4 reports and 6 command literals from the sh, so a new sh
message fails it until the PS1 has it.

Gates: `npm run build` ok; `npm test` 730 files / 7527 tests, 2 failed (the
known `MobileHeldPromptStore` date bomb, nothing else); `cargo test` 3714
passed (+1 test); `cargo clippy --all-targets -D warnings` ok; `npm run lint`
0 errors / 28 warnings; `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` ok; `git diff --check` clean; `bash -n
scripts/install_phone.sh` ok. No PowerShell here: the PS1 change is
read-verified only.

Flagged for user:
- `install_phone.sh` probes python3 by running it. On a Mac without the
  Command Line Tools, `/usr/bin/python3` is the xcrun stub, which may pop
  the "install developer tools" dialog before the script falls through to
  jq. Harmless, but a surprise window; the alternative (`xcode-select -p`
  first) is a design call.
- `tabtivity-send.ps1` origin path: `GetUnresolvedProviderPathFromPSPath`
  is used without `[IO.Path]::GetFullPath` around it (§3.5 names
  `GetFullPath`). If PowerShell leaves a `..` in an absolute source path,
  the `.src` records `sub/../x`; `files::entry` proves the path, so the
  worst case is a missing origin, never a wrong file. Unverifiable here.
- Windows PowerShell 5.1 writes stdout in the console's OEM code page, so
  the `→`/`—` of the report line may reach the agent as `?`. Cosmetic.
