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

## A5 — 3.6 + 3.9

Commit: the one that carries this section — `git log -1 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a5` (one commit for the step).

Per file:
- `src-tauri/src/services/agent_session.rs` — `posix_hook_script_body(live_dir)`
  keeps its signature and calls the new `posix_hook_script_body_with(live_dir,
  proc_root)` with `/proc`. The `clear|resume` arm wraps the unchanged `/proc`
  loop (now spelled with `{proc_root}`) in `if [ -r "<root>/$PPID/environ" ]`;
  the `else` branch walks with `ps`: `e=$(ps -E -o command= -p $p)` split on
  spaces and matched `-qx "[A-Z]*_TAB_UID=<uid>"` (any tab-id name, as the
  `/proc` branch), a `claude` counted when the basename of `ps -o comm=` **or**
  of argv[0] (first word of `e`) is `claude`, parent from `ps -o ppid=` with
  spaces stripped, loop guarded by `[ "$p" -gt 1 ]`. Script comment's "Without
  /proc nothing is counted" sentence replaced; the `hook_script_body` doc
  comment names the `ps` fallback. New test
  `hook_script_walks_the_chain_with_ps_where_proc_is_unreadable` (`cfg(unix)`):
  procfs root = empty temp dir, a `ps` shim on `PATH` answering `ppid=` /
  `comm=` / `command=` (environment only with `-E`) from a scripted chain
  starting at the test's own pid (the hook's `$PPID`); covers alone (full-path
  comm) → taken, nested → refused, `claude` outside the tab → taken, legacy
  name only + retitled argv[0] → refused, another tab's id → taken, empty
  `ps` → taken, for both `resume` and `clear`; also asserts the production
  body equals `_with(…, "/proc")`. The existing `/proc` test is untouched.
  Mutation-checked: dropping `-E` from the script fails the new test.
- `src-tauri/src/commands/workspace.rs` — `network_identity_blocking`'s
  `lan` arm calls `wired_gateway()` on every OS: Linux the old `/proc` reads
  (moved, unchanged), macOS `route -n get default` → `gateway_from_route_get`
  then `arp -n <ip>` → `mac_from_arp_n`, Windows `route print -4` →
  `gateway_from_route_print` (lowest-metric `0.0.0.0 0.0.0.0 <ipv4> <if>
  <metric>` row; headings ignored since localised; `On-link`/`Default` rows
  fall out) then `arp -a <ip>` → `mac_from_arp_a`; all through
  `probe_output_capped`. New `canonical_mac` pads/lower-cases macOS
  `2:0:0:0:a:1` and Windows `02-00-…-0A-01` to the `/proc` spelling and drops
  all-zero/broadcast. `wifi_ssid_macos` reads `interface:` through the new
  shared `route_get_field`. `NetworkIdentity.gateway_ip` doc updated. Five
  parser tests on captured-shape text (RFC 5737 addresses, a 02:… MAC).
- `src-tauri/src/services/dev_build.rs` — `lock_holder_alive` →
  `crate::commands::apps::pid_alive`; `own_exe` → `std::env::current_exe()`,
  the ` (deleted)` strip under `cfg(target_os = "linux")`, `(exe, false)`
  elsewhere; `spawn_relauncher` returns `"dev relaunch is Linux-only"` off
  Linux right after the `SOURCE_ROOT` check (shown raw by the chip's
  `ErrorNote`, like its sibling errors).
- `src-tauri/src/commands/ollama.rs` — non-Linux `remove_blob_files_elevated`
  says the files "belong to another account or are locked by a running
  Ollama; quit Ollama or remove them as their owner" (no frontend matches the
  text — checked).
- `src/lib/window/printerNetworkDefaults.ts` — module comment only (wired id
  now read on macOS/Windows too).
- `todo/group-s-agents.md` — new `[~]` item right under the PowerShell guard
  item: macOS `ps` fallback, 🤖 ticked, 🖐️ with the four platform pairs.
  Nothing ticked on the PowerShell item.
- `todo/group-h-crossplatform.md` — new `32q` (gateway twins, dev-build
  chip, Ollama wording) with the four platform pairs.
- `docs/filemap_backend.md` — `commands/workspace.rs` row names the
  wired-gateway probes.

Choices where the plan left room:
- The fallback is chosen per walk by the first parent's `environ` being
  unreadable (the plan's wording); Linux with `/proc` never enters it. If it
  ever does on Linux, procps `ps -E` is an "unsupported SysV option" error →
  nothing counted → the start is taken, exactly today's behaviour.
- A `claude` is also counted by argv[0]'s basename, not only `ps -o comm=`
  (the plan's wording): macOS `comm` prints the executable path, which for the
  native installer is the versioned binary, and a node-based CLI retitles its
  argv rather than its comm. Over-counting needs two such processes carrying
  the tab id, so the tab's own `/clear` (one `claude`) is still taken.
- `arp -a <ip>` / `arp -n <ip>` are called with the gateway to keep the output
  to one entry; the parsers still check the address.
- MACs are canonicalised so a settings file shared between a Linux and a
  macOS/Windows machine on the same LAN maps to the same `gateway_id`.
- No new `UntestedTag`: the per-network UI already carries
  `printing.networkSet` / `printing.networkDefaults`; the hook has no UI.
- `route`/`arp` are spawned bare like the sibling `netsh`/`networksetup`
  probes; trusted-helper resolution on Windows is A6's (§3.7).

Gotchas:
- macOS `ps -E` shows the environment only for the user's own processes and
  only as it was at exec; neither is a problem here (the tab id is set at
  spawn, all tab processes are the user's). Read-verified only — macOS `ps`
  output shapes (`comm` = path, leading spaces on `ppid=`) are from memory.
- The test shim answers by the test process's pid: the hook is run as `sh
  <script>` directly from the test, so its `$PPID` is `std::process::id()`.
- Windows clippy cross-check (`--target x86_64-pc-windows-msvc -D warnings`)
  ran: 14 pre-existing findings (apps.rs ×7, network.rs, screenshot.rs,
  platform/mod.rs, platform/windows.rs ×2, project_runtime.rs, vm.rs), none
  in the files this step touched — A9's. Windows `cargo check` passes.
- One `npm test` run showed 2 extra failures (a markup-ask card `waitFor`
  under load); a rerun had only the two known ones. No TS logic changed.

Gates: `npm run build` ok; `npm test` 730 files / 7527 tests, 2 failed (the
known `MobileHeldPromptStore` date bomb); `cargo test` 3720 passed (+6: one
hook test, five parser tests); `cargo clippy --all-targets -D warnings` ok;
`npm run lint` 0 errors / 28 warnings; `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` ok; `git diff --check` clean; Windows `cargo
check` ok.

Flagged for user:
- The macOS `ps` fallback and the macOS/Windows gateway parsers have never
  run on a Mac or Windows box; first live check is §6 macOS 2–3 and the 32q
  manual line.
- The PowerShell nested-`claude` walk stays unbuilt (decision 5, the
  "only with a Windows box" rule).

### Reviewer

Findings:
- **Fixed — macOS `ps` cut the environment off.** BSD/macOS `ps` truncates
  its last column to the terminal width; the hook has no tty (stdin a pipe,
  stdout captured, stderr `/dev/null`), so the width is 79 (or `$COLUMNS`).
  `-E` appends the environment *after* the arguments (Apple's
  `getproclline`), so the tab id — somewhere in a full environment — was
  practically always cut off: the walk stopped at the first process, nothing
  was counted and every nested `claude --resume` was taken, i.e. the fallback
  never refused anything. Same for `-o comm=` (macOS prints the executable
  path; a long one loses its basename). Both calls now pass `-ww` (unlimited
  width, overrides `$COLUMNS`). Regression: the `ps` shim now cuts at 79
  columns unless given `-ww`, and a new "long ps lines" case (versioned native
  path, tab id after other env vars, an 88-char `comm`) is refused;
  mutation-checked — dropping either `-ww` fails it. Fix commit: the
  `fix(hook)` commit on `osfix/a5` after fbb66ed5.
- Checked, fine: Linux `/proc` loop byte-identical inside the new `if`;
  POSIX sh only (`${e%% *}`, `${c##*/}`, `[ -gt ] 2>/dev/null`, `&&` line
  continuation — no bashisms for bash 3.2 sh mode); `ps -o ppid=` leading
  spaces stripped; macOS `-E` needs the same real uid (all tab processes are);
  `route -n get default` / `arp -n` shapes, Windows `route print -4` 5-column
  active rows vs 4-column persistent rows, `arp -a` 3-column rows, MAC
  canonicalisation matching `/proc` (Linux hash unchanged); `current_exe` on
  Linux is the same `read_link("/proc/self/exe")` (no `(deleted)` stripping
  in std); `pid_alive` is `/proc` / `OpenProcess` / `kill(pid, 0)`; Ollama
  text names no brand and no frontend matches it.

Flagged for user (not changed):
- `dev_build::status` on macOS: `own_exe` now answers there, so `frozen` (and
  `can_relaunch`) can be true while `spawn_relauncher` always refuses "Linux
  only" — a chip button that only errors. Unreachable unless a macOS window
  runs from the dev `app_dir` binary, which only the Linux script produces.
- macOS/Windows wired-network key changes from `lan` to `lan:<gateway_id>`
  once the gateway MAC resolves: a per-network default printer saved there
  under plain `lan` (before this step) no longer applies. Feature is untested
  on those OSes; a fallback to `lan` would be a design change.
- macOS `ps -E` against a hardened-runtime / notarised `claude` binary is
  assumed to work (KERN_PROCARGS2, same uid); read-verified only.

Gates (reviewer, after the fix): `npm run build` ok; `npm test` 730 files /
7527 tests, 2 failed (the known `MobileHeldPromptStore` pair); `cargo test`
3720 passed (one run under parallel `npm test` load failed the timing-based
`api_usage::the_book_writes_on_flush_and_reads_its_file_back` — passes alone
and in a quiet full rerun, not this step's); `cargo clippy --all-targets -D
warnings` ok; `npm run lint` 0 errors / 28 warnings; `scripts/brand-check.sh`
ok; `scripts/privacy-check.sh` ok; `git diff --check` clean; Windows `cargo
check` ok.

## A6 — 3.7

Commit: the one that carries this section — `git log -1 --format=%h -- docs/macos_windows_completion_handoff.md` on `osfix/a6` (one commit for the step).

Per file:
- `src-tauri/src/services/private_file.rs` (new) — pure cores
  `classify_sid(authority, subs)` (Administrators S-1-5-32-544, SYSTEM
  S-1-5-18, TrustedInstaller S-1-5-80-956008885-…, else `Other`),
  `sid_string`, `windows_acl_is_locked(owner, Option<&[AceEntry]>)` (trusted
  owner, a DACL present, no non-inherit-only allow ACE for `Other` with any
  write right: write/append data, EA, delete child, attributes, `DELETE`,
  `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_ALL/WRITE`), `icacls_restrict_steps`.
  `cfg(windows)`: `restrict_to_owner(path)` (user SID from the process token
  → `icacls <p> /grant:r *<sid>:F /Q`, then `icacls <p> /inheritance:r /Q`;
  failure → `eprintln!`, never an error) and `admin_locked(path)`
  (canonicalize, regular file, `GetFileSecurityW` owner + DACL of the file
  **and** its folder). Unparsed allow ACE types count as "anyone may write".
- `src-tauri/src/services/win_links.rs` (new) — pure `mklink_junction_line`
  (both paths quoted, `\\?\` dropped, `"` refused) + `cfg(windows)`
  `make_junction`. Replaces the private copies in `commands/boxes.rs`
  (`make_member_link`) and `services/brand_migration/state_dir.rs`
  (`link_dir`'s fallback, a third copy the plan did not list).
- `src-tauri/src/paths.rs` — `system_executable` Windows arm:
  `windows_system_bin_dirs(ProgramFiles, SystemRoot)` = `Git\cmd`, `Git\bin`,
  `System32\OpenSSH`, `System32\WindowsPowerShell\v1.0`, `System32`; file
  `<bin>.exe` through `first_trusted_in` (now un-gated) with
  `private_file::admin_locked`. `TRUSTED_HELPERS` gains `cmd`, `powershell`,
  `icacls`. Test of the dir order.
- `src-tauri/src/services/agent_install.rs` — `install_env_for(windows,
  state_dir)` adds `USERPROFILE` (= install home) and `APPDATA`
  (`<home>\AppData\Roaming`) on Windows; `bin_dirs_for(windows, …)` adds the
  npm prefix root on Windows. `install_env_in`/`bin_dirs_in` keep their
  signatures (`cfg!(windows)`). New test for both values.
- `src-tauri/src/commands/agents.rs` — both Windows spawns (PowerShell,
  `cmd /C`) and the `sh` one go through the new `into_install_home` (create
  the home and the `APPDATA` stand-in, install env, `agent_install_path()`,
  now un-gated).
- `src-tauri/src/commands/project_transfer.rs` — Windows `make_symlink`:
  target `/`→`\` (`windows_link_target`, tested), resolved against the
  link's folder; a directory → `symlink_dir`, on os error 1314 a junction to
  the canonicalized target; otherwise `symlink_file` as before.
- `src-tauri/src/services/mail_crypt.rs` — `harden` calls
  `restrict_to_owner` on Windows; the post-rename `harden` is Unix-only (the
  rename keeps the temp file's ACL — one `icacls` pair per write, not two).
- `src-tauri/src/services/mobile_control/store.rs` — `write_bytes_atomic`
  restricts the temp file right after creating it, before any byte is
  written; `ensure_private_file`'s non-Unix arm says why it stays `Ok(())`.
- `src-tauri/src/storage.rs` — `write_json_file`'s private branch restricts
  a file this call creates (not every rewrite: an `icacls` spawn per state
  write would be too costly; mirrors the Unix create-mode semantics).
- `src-tauri/src/services/mod.rs` — two module lines with comments.
- `docs/filemap_backend.md` — rows for `private_file.rs` (next to
  `mail_attach.rs`) and `win_links.rs`; `paths.rs` and `agent_install.rs`
  rows updated.
- `todo/group-h-crossplatform.md` — new `32r` with the four platform pairs.

Choices where the plan left room:
- **ACL read through the API, not `icacls` text.** `GetFileSecurityW`,
  `GetSecurityDescriptorOwner/Dacl`, `GetAce` and the SID accessors are all
  in the already-enabled `Win32_Security` feature (the plan's reason for
  `icacls` was that `GetNamedSecurityInfoW` needs a new feature). `icacls`
  prints localized principal names (`VORDEFINIERT\Administratoren`) and no
  owner, so text parsing would fail closed on every non-English Windows and
  could not check the owner at all. The pure core is a decision over
  classified SIDs + masks instead of over text; tested with the stock
  Program Files / System32 shapes. No new crate feature, no spawn per check,
  no cache.
- `restrict_to_owner` grants the user's **SID** (`*S-1-5-21-…`), not a
  name, and grants before it drops inheritance, so a half-failure never
  leaves an empty ACL (an unreadable key file would be an unopenable
  mailbox).
- `cmd`/`powershell`/`icacls` joined `TRUSTED_HELPERS` so the junction
  helper, the installer spawns and `restrict_to_owner` itself get the
  System32 copies instead of whatever `PATH` (with `~\.local\bin` first)
  finds. Unix has no root-owned copies of those names → unchanged there.
- Junction helper is its own `services::win_links` (plan's second option).
- `LOCALAPPDATA` is not redirected (plan named only `USERPROFILE`/`APPDATA`):
  installers that put launchers there would land in a dir `bin_dirs` does
  not list.

Gotchas:
- The `cmd /C mklink /J "…"` line expands `%VAR%` inside the quotes (cmd
  does that even quoted) — pre-existing in all three copies; a folder named
  with two `%` around an existing variable name would get the wrong link.
  Not fixed (no reliable `%` escape on a `cmd /C` line; a native
  `FSCTL_SET_REPARSE_POINT` would be the fix).
- An installer that asks the shell API (`SHGetKnownFolderPath`) for the
  profile instead of reading the env still lands in the user's profile.
- Windows `ssh` now prefers `System32\OpenSSH\ssh.exe` over a Git-for-Windows
  or winget copy earlier on `PATH` (same rule as Linux preferring
  `/usr/bin`); ssh-agent pairing differs between the two.
- `cfg(windows)` code compiles (cross `cargo check`/`clippy`) but has never
  run; the FFI (`TOKEN_USER` cast, `ACCESS_ALLOWED_ACE.SidStart`) is
  read-verified only.
- The threat model's #861 row (`docs/threat_model.md:31`) still describes
  only Unix; not edited because the main checkout has uncommitted edits to
  that file from another session.

Gates: `npm run build` ok; `npm test` 730 files / 7527 tests, 2 failed (the
known `MobileHeldPromptStore` pair); `cargo test` 3730 passed (+10);
`cargo clippy --all-targets -D warnings` ok; `npm run lint` 0 errors / 28
warnings; `scripts/brand-check.sh` ok; `scripts/privacy-check.sh` ok; `git
diff --check` clean; Windows `cargo check` ok; Windows `cargo clippy` only
the 14 pre-existing findings (A9's), none in this step's files.

Flagged for user:
- Nothing here has run on Windows: §6 Windows 4 and the `32r` manual line
  are the first live checks (Codex install location, git status in a file
  tree, the phone key file's ACL, a re-imported directory link).
- The ACL check via the API instead of the plan's `icacls` parsing (see
  Choices) — a deliberate deviation.
- Threat-model row #861 wants a Windows sentence once the concurrent edit
  to `docs/threat_model.md` lands.

### Reviewer

Read-verified against the Win32 contracts (nothing here can run on
Windows): `classify_sid` (S-1-5-18, S-1-5-32-544, the TrustedInstaller
S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464 all
correct); `WRITE_RIGHTS` covers write/append data, EA, delete child,
attributes, `DELETE`, `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_ALL/WRITE` and
does not overlap a stock `(RX)` = `0x1200A9`; NULL/absent DACL, owner-less
descriptor, unreadable file, unknown allow-ACE type and every API failure
all end in "not locked"; deny ACEs never unlock; inherited ACEs count,
inherit-only ones are skipped. Stock `System32\cmd.exe`/`icacls.exe`, the
`System32` folder and a per-machine `Program Files\Git\cmd` all pass the
rule. Buffers are sized by the first call and outlive every pointer into
them; the token handle is closed on every path. `icacls` order (grant the
user SID, then `/inheritance:r`) and the `*S-1-…` spelling are right; std
quotes the path argument. Installer env keeps `USERPROFILE`/`APPDATA`
inside the install home. Unix behaviour unchanged (the three new
`TRUSTED_HELPERS` names have no root-owned copy there and are never spawned
there).

Fixes (one commit, `fix(windows): ...` after 02da4361):
- `win_links::mklink_junction_line` turned the verbatim UNC form
  `\\?\UNC\srv\share\x` (what `canonicalize` returns on a mapped network
  drive, and what `make_symlink`'s junction fallback passes) into the
  *relative* `UNC\srv\share\x`, which `mklink /J` resolves against `cmd`'s
  working directory — a junction to the wrong place. Now `\\srv\share\x`
  (mklink then refuses a non-local target loudly). Test
  `a_verbatim_unc_path_keeps_its_leading_backslashes`.
- Remove of an npm-installed CLI (`uninstall_agent` → `npm uninstall -g`)
  ran without the install home's environment, so `-g` meant the user's own
  npm prefix: a CLI Tabtivity installed into its home (Unix since the
  install home landed; Windows new with this step) was not removed ("still
  detected") and a same-named copy in the user's prefix would have been.
  Now the uninstall gets `into_install_home` when the detected binary lies
  in the install home (`agent_install::owns_path{,_in}`, factored out of
  `owns_command_in`); a host-installed CLI is uninstalled as before. Test
  extends `a_command_is_owned_only_when_it_resolves_inside_the_install_tree`.
- `private_file::win::read_security` took the ACE's SID pointer from a
  reference to `ACCESS_ALLOWED_ACE`, whose provenance covers only the
  struct's one-`u32` `SidStart`, then read the SID past it; now from the raw
  ACE pointer. No behaviour change; Windows `cargo check`/`clippy` only.

Flagged for user:
- `uninstall_agent` still runs `npm uninstall -g` against the user's own npm
  prefix for a CLI the user installed on the host (pre-existing). That edits
  another app's paths at the user's request; whether Remove should do that
  at all is a product call.
- `cmd /C` (junctions, installers, npm uninstall) runs without `/D`, so a
  `HKCU\Software\Microsoft\Command Processor\AutoRun` entry runs first and
  can change the cwd or print into captured output. Only reachable with
  user-level registry write; `/D` would make the spawns deterministic.
- `admin_locked` checks the canonical file's folder, like the Unix
  `root_owned_file`, not the lookup dir itself; a user-writable lookup dir
  holding a link to a locked file would pass. Needs the symlink privilege or
  a junction on the dir, and Program Files / System32 are not user-writable
  on a stock install.
- `make_symlink` now probes the archive's link target (`is_dir`) during
  import; a UNC target makes Windows open an SMB session to that host with
  the user's credentials. Anything walking the link later does the same
  (pre-existing), but the probe moves it to import time.
- `mobile_control::store::write_bytes_atomic` spawns two `icacls` per write
  (cost, not correctness).

Gates (reviewer, 2026-10-08): `npm run build` ok; `npm test` 730 files /
7527 tests, 2 failed (the known `MobileHeldPromptStore` pair; a first run
under load average ~28 had 39 timing failures, the rerun only the pair);
`cargo test` 3731 passed (+1); `cargo clippy --all-targets -D warnings` ok;
`npm run lint` 0 errors / 28 warnings; `scripts/brand-check.sh`,
`scripts/privacy-check.sh` ok; `git diff --check` clean; Windows `cargo
check` ok; Windows `cargo clippy` the 14 pre-existing findings (A9's), none
new.

## A7 — 3.8 + 3.10

Range: `a0772c5d..` the commit that carries this section on `osfix/a7`
(`git log -1 --format=%h -- docs/macos_windows_completion_handoff.md`; one
commit for the step). `a0772c5d` (`/D` on every one-shot `cmd /C`) is the
main agent's, committed under this step at the user's request.

Per file:
- `src-tauri/src/services/agent_fence.rs` — `SeatbeltInputs` gains `pinned`
  (rendered `(deny file-write* (literal …))` after `protected`). New pure
  `cfg(any(macos, test))` helpers: `seatbelt_git_guard` (`GuardPaths` →
  `protected` + `pinned`), `seatbelt_temp_dirs` (the four temp roots +
  `$TMPDIR`, moved out of `sandbox_exec_inputs`), `one_shot_seatbelt_inputs`
  (roots, allowlist readable, temp writable, git guard, Cargo credentials +
  every `private_state_paths` entry hidden — the whole state dir, since no
  tool mount must pierce it — `own_home: None`). New `cfg(macos)`
  `one_shot_command`: fails closed on `!bwrap_available()` with
  `fence_unavailable_message()`, unknown scope refused as on Linux, profile
  written to `sandbox::stage_dir(scope)/preflight.sb`, returns
  `/usr/bin/sandbox-exec -f <profile> <cmd> <args>` with `current_dir(cwd)`
  and `AGENT_FENCE=1`. The stub is now `not(any(linux, macos))`.
  `sandbox_exec_inputs` (the tab fence) now also applies
  `git_guard::guard_paths(roots, cwd)` — see Choices. New test
  `the_one_shot_profile_guards_git_and_hides_state_without_an_agent_home`
  (also asserts a PTY-shaped input keeps its `own_home` allow as the last
  line).
- `src-tauri/src/sysstat.rs` — `procargs2_args` (argc + bytes from argv[0])
  shared by `parse_procargs2` (unchanged behaviour) and the new
  `pub(crate) procargs2_env` (bytes after the argc argv strings; empty on a
  malformed buffer). macOS backend: the sysctl read split into
  `platform::procargs2_raw` (whole buffer) that `cmdline` uses, plus
  `platform::comm` (`pbi_comm` via `bsd_info` + `decode_ansi_nul`, the same
  call the snapshot already makes); crate-level `cfg(macos)` wrappers
  `procargs2_raw`, `comm`. Fixed a misplaced doc comment
  (`bsd_process_state`'s doc sat on `parse_procargs2`). New test
  `procargs2_env_starts_after_the_argv_strings` (fixture of the existing
  test plus an empty argv entry and the trailing `apple[]` string).
- `src-tauri/src/services/agent_turn.rs` — the walk is now a shared
  `background_job_uids(want, pids, &impl ProcProbe)` (trait: `comm_ppid`,
  `environ`, `cmdline`), same order as before (comm filter → environ →
  uid → cmdline → parent comm). Linux `tool_shell_uids` = the old `/proc`
  reads behind the trait (ppid now parsed to `u32`; behaviour identical).
  macOS `tool_shell_uids`: pids + parents from one `sysstat::parent_map()`,
  comm from `sysstat::comm`, environment from
  `procargs2_env(procargs2_raw(pid))` read only for shells, fed only to
  `environ_uid`. Windows stub says why (no environment-block reader). The
  five helper cfgs widened to `any(linux, macos, test)`. New test
  `the_walk_reads_the_tab_id_from_the_environment_half_of_procargs2` (fake
  table of macOS-shaped buffers: a background job found, a foreground tool
  call not, a tab id in argv ignored, `Done` turns the foreground one into a
  job, empty `want` reads nothing).
- `src-tauri/src/services/git_push_mcp.rs` — unchanged: the
  `FenceUnavailable` text already passes the fence's own error through
  (`{e}`), and the Windows `PreflightFailed` sentence names the right
  platform.
- `docs/context/git_push_mcp.md`, `docs/context/agent_authority.md` — macOS
  preflight and the Seatbelt git guard described.
- `docs/filemap_backend.md` — `agent_turn.rs` and `agent_fence.rs` rows.
- `todo/group-h-crossplatform.md` — new `32s` with the four platform pairs.

Choices where the plan left room:
- **Tab fence gained `git_guard` on macOS.** `sandbox_exec_inputs` never
  applied it: a fenced Mac agent could write `.git/hooks/*` and
  `.git/config` (the #158 trust handoff the threat model lists as covered).
  The plan said to leave `sandbox_exec_inputs` alone unless a pure move; this
  is a behaviour change, made under the "fix the sibling bug" rule because
  the one-shot needs the same rendering. Control files → `subpath` write
  denies; `.git` → a `literal` write deny (Seatbelt checks create/unlink on
  the child's own path, so git's lock files and objects stay writable).
- `writable` = temp dirs in the one-shot (the plan listed none): the Linux
  one-shot gets a private `/tmp` tmpfs, and the tab's own profile already
  grants the same temp dirs, so the preflight is no wider than the tab.
- `HOME` unchanged for the one-shot (plan: `own_home: None`, `home` from
  `home_dir_string()`); the default allowlist carries `~/.gitconfig` and
  `~/.config/git`, so git's own config reads succeed.
- `comm` from `pbi_comm` rather than argv[0] out of `cmdline` (plan's
  wording): one `proc_pidinfo` like the existing `ppid`, the same 16-byte
  executable name Linux's `comm` is, and no sysctl for non-shells.
- `live_unfenced_by_scope` on macOS not built (plan: dropped, §5).

Gotchas:
- **macOS cross-check now works here.** `cargo check`/`clippy --target
  aarch64-apple-darwin` stop in `objc2-exception-helper` only because `cc`
  is GNU; check-only shims (a `cc` that touches `-o`'s file, an `ar` that
  touches the `.a`) get past it: `CC_aarch64_apple_darwin=<shim>/cc
  AR_aarch64_apple_darwin=<shim>/ar cargo check --target
  aarch64-apple-darwin` → `Finished` (one pre-existing warning,
  `screenshot.rs:783` unused `Command`). Never links, so only type/borrow
  checking. macOS clippy (`-D warnings`, lib): 12 pre-existing findings
  (`apps.rs` ×4, `network.rs`, `screenshot.rs`, `subwindow.rs`, `lib.rs`,
  `platform/mod.rs`, `net_usage.rs`, `project_runtime.rs`, `vm.rs`), none in
  this step's files — useful to A9 / the staged macOS clippy step. The
  shims lived in this session's scratchpad (two 5-line `sh` scripts).
  The macOS build writes an untracked `src-tauri/gen/schemas/macOS-schema.json`;
  delete it, don't commit it.
- Seatbelt denials answer `EPERM`, Linux's empty home `ENOENT`: a hook that
  reads an un-allowlisted dotfile (`~/.npmrc`) or writes under `$HOME`
  (`~/.cache`) fails on macOS where it carries on in the Linux one-shot. git
  `die`s on `EPERM` for a config file it is told about — fine with the
  default allowlist, not if the user removed `~/.gitconfig` from it.
- An empty argv[0] would be eaten by `procargs2_args`'s padding skip
  (pre-existing in `parse_procargs2`); `procargs2_env` would then start one
  string late and could miss a tab id that is the first environment entry.
  Not reachable for the shells it reads.
- `procargs2_raw` hands the crate the whole buffer, environment included;
  its doc names the one allowed use.

Gates: `npm run build` ok; `npm test` 730 files / 7527 tests, 2 failed (the
known `MobileHeldPromptStore` pair); `cargo test` 3734 passed (+3);
`cargo clippy --all-targets -D warnings` ok; `npm run lint` 0 errors / 28
warnings; `scripts/brand-check.sh` ok; `scripts/privacy-check.sh` ok; `git
diff --check` clean; Windows `cargo check` ok, Windows `cargo clippy` the 14
pre-existing findings (A9's), none new; macOS `cargo check` ok (shims, see
Gotchas), macOS `cargo clippy` 12 pre-existing, none in this step's files.

Flagged for user:
- Never run on a Mac: §6 macOS 1 and the `32s` manual line are the first
  live checks (fenced `git_push` with a pre-push hook; `.git/hooks` write
  refused but `git commit` working in a fenced tab; the background-job
  mark).
- The tab fence's git guard on macOS is a behaviour change beyond the plan
  (see Choices); if `git commit`/`git gc` in a fenced Mac tab breaks, the
  `.git` `literal` deny is the first suspect.
- `docs/threat_model.md` row for "planting in `.git/`" still says
  "verified under real bubblewrap" only; not edited (the main checkout has
  concurrent edits to that file).

### Reviewer

Read-verified (nothing here runs on a Mac). SBPL: last match wins, and the
render order is right for both profiles — `(allow default)`, the `$HOME`
read deny, then the readable/root/temp read allows, the blanket
`(deny file-write*)`, device and root/temp write allows, then `protected`
(now with `git_guard`'s control files, `subpath`), `pinned` (`.git` as a
`literal`, so lock files, objects and refs inside it stay writable), the
`hidden` denies and, for a tab only, the `own_home` allow last. The one-shot
has no allow after its hidden denies, so the whole state dir, the
`preflight.sb` stage dir included, stays out of reach; the stage dir is never
writable to a fenced tab either (state dir, not temp). `sbpl_string`
escapes `"` and `\`, the only characters special inside a Scheme string, so
no path can leave its literal. `guard_paths` canonicalises, so the guard
denies name `/private/...` forms, which is what Seatbelt matches; a
non-canonical root only ever fails closed (its allow never matches).
Fail-closed: `!bwrap_available()`, an unknown scope, a failed stage-dir
create or profile write all return `Err` → `fence_unavailable`; a
`sandbox-exec` that refuses the profile exits non-zero →
`preflight_failed`. The hook is the repo's own `pre-push`, run inside the
fence without the token, the same posture as the Linux one-shot.
`procargs2_env`: `get(0..4)` before the slice, the exec-path scan is
`position`-bounded, each argv skip consumes at least one byte and a missing
NUL answers empty, so a short, truncated or junk buffer cannot panic and a
huge `argc` cannot loop past the buffer; only `environ_uid`'s one match
leaves the walk. Linux walk unchanged (same order of reads, pid/ppid now
`u32`); Windows still answers no jobs.

Fixes: none — no confirmed bug.

Flagged for user (cannot be settled without a Mac):
- **Hard links and case variants past the Seatbelt git guard.** Seatbelt
  matches paths, bubblewrap mounts. On Linux `ln .git/config x` from a
  read-only bind fails `EXDEV`; on macOS the profile denies only
  `file-write*` on the guarded paths, and `file-link` is not part of
  `file-write*`, so a fenced agent may be able to hard-link `.git/config`
  (or a hook script) to an unguarded name and write through it. Likewise a
  case-variant path (`.GIT/CONFIG` on a case-insensitive APFS volume) if
  Seatbelt matches the looked-up spelling. The same applies to the
  pre-existing `protected` entries (hook scripts, `settings.json`). First
  live check: in a fenced Mac tab, `ln .git/config x && echo >> x` and
  `echo >> .GIT/CONFIG` must both be refused. A `(deny file-link …)` rule
  was not added blind: an operation name the profile compiler rejects would
  stop every fenced Mac agent from starting.
- **The implementer's tab-fence `git_guard` (kept).** Correct as rendered:
  control files `subpath`-denied after the root allows, `.git` pinned by a
  `literal` that covers the entry (rename/unlink/replace) and none of its
  children. Seatbelt could also deny *creating* a missing `commondir` /
  `hooks` / `config.worktree` (closing the residual `git_guard.rs`
  documents for bwrap), but `guard_paths` lists only existing paths; a
  possible follow-up, not a bug.
- **`preflight.sb` is shared per scope and written in place.** Two box
  members pushed at once hold different project locks, so both preflights
  `fs::write` the same file; a reader between the truncate and the write
  sees an empty profile. Contents are normally identical (same box roots),
  and an empty profile should be refused by `sandbox-exec` (fail closed) —
  unverified. A temp-file + rename write would remove the window. The tab's
  `fence.sb` has the same, older shape, and there the contents differ per
  CLI (`agent_state_mounts` reads the tab's env), so a Claude and a Codex
  tab spawned together in one scope can run under each other's profile
  (pre-existing, not this step).
- Pre-existing, both fences: roots enter the profile uncanonicalised, so a
  project reached through a symlinked folder is not writable at all under
  Seatbelt (fails closed; a version-bump `pre-push` would fail).

Gates (reviewer, 2026-10-08): no code change; targeted `cargo test`
(`one_shot`, `procargs2`, `the_walk_reads`, `background`, `seatbelt`,
`sandbox_exec`: 15 passed); `scripts/brand-check.sh`,
`scripts/privacy-check.sh` ok; `git diff --check` clean. The implementer's
full gate run above stands for the unchanged code.

## A8 — 3.11

Range: `8736eba5..` the commit that carries this section on `osfix/a8`
(`git log -1 --format=%h -- docs/macos_windows_completion_handoff.md`; one
commit for the step).

Per file:
- `src-tauri/src/services/mail_attach.rs` — `WINDOWS_REFUSED` and the
  `not(linux|macos)` `read_from_roots` stub deleted; `read_from_roots`,
  `within_grant`, `root_refusal`, `root_label`, `Miss` are now compiled
  everywhere (their `cfg`/`allow(dead_code)` gone). New `cfg(windows)`
  `read_under`: `files::ProjectDir::open_root(root)` (failure → `NotFound`,
  like the unix root `open`), `lookup_dir` per directory component,
  `lookup_file` for the leaf; `Ok(None)` → `Miss::NotFound` (next root),
  `Err(())` → `Miss::Refused("'x' is a link or not a folder / not a regular
  file; links (junctions, symbolic links) are never followed …")`. The cap is
  a shared `read_capped(file, name, max)` both arms call (unix arm behaviour
  unchanged). New pure `windows_part_refusal` (applied in `components` under
  `cfg!(windows)` only): `:` (drive / ADS), `~` + digit (8.3 short alias),
  trailing `.`/space. New `under_any_case` for the joined-path state check.
  Module docs describe the Windows walk. Tests: `windows_aliases_are_refused_before_io`
  and `the_state_check_ignores_case` (all platforms),
  `a_project_outside_the_spawn_grant_is_refused` widened to all platforms,
  new `cfg(windows)` `junctions_are_refused_never_followed` (own `mklink /J`
  helper, a copy of `files.rs`'s).
- `src-tauri/src/services/mobile_control/files_windows.rs` — `ProjectDir`,
  `open_root`, `lookup_dir` widened to `pub(crate)`; new `pub(crate)
  lookup_file` (tri-state, the file twin of `lookup_dir`). `open_at` deleted:
  `child_dir` = `lookup_dir().ok().flatten()`, `open_file` =
  `lookup_file().ok().flatten()` — the same `NtCreateFile` flags and
  metadata checks as before, so the phone paths are unchanged.
- `src-tauri/src/services/mobile_control/files.rs` — the Windows re-export
  is `pub(crate) use windows::ProjectDir` (unix `ProjectDir` untouched).
- `src-tauri/src/services/agent_fence.rs` — `private_state_paths` lost its
  `cfg(linux|macos|test)` (Windows `attach` needs it; pure).
- `src-tauri/src/services/root_mcp_mail.rs` — the `cfg!(not(linux|macos))`
  early refusal in `attach_files` deleted; `attach_needs_a_tab_that_reads_the_projects`
  lost its Windows branch; `attach_on_update_replaces_keeps_or_clears` now
  runs on every platform (plain files only). The big table test stays
  unix-only (symlinks, FIFO).
- `src-tauri/src/services/mail_store.rs` — `content_is_pinned_at_call_time`
  now runs on every platform.
- `docs/filemap_backend.md` — `mail_attach.rs` and `files_windows.rs` rows.
- `todo/group-h-crossplatform.md` — new `32t` with the four platform pairs.

Choices where the plan left room:
- **Widened `ProjectDir` rather than a `read_project_file` wrapper**, and
  through `lookup_dir` + a new `lookup_file` instead of `child_dir` /
  `open_file`: those two answer `Option` and fold "missing" and "a junction
  is there" together, which would let a junction fall through to the next
  box root instead of refusing on the spot as the unix arm does. `open_at`
  became redundant and was folded into the two lookups.
- **Windows-only name checks before I/O** (beyond the plan's "component
  validation"): `NtCreateFile` resolves 8.3 short names, so `GIT~1/config`
  or `ENV~1` would have opened `.git/config` / `.env` past the `.git` and
  secret-name checks; `:` is refused here rather than by `plain_segment`'s
  `InvalidInput` (which would surface as the "link" sentence). Cost: a real
  name like `backup~2.txt` cannot be attached on Windows.
- **Case-folded state check on every platform** (`under_any_case`): the
  joined-path check compared case-sensitively, but Windows (and a default
  APFS volume on macOS — a sibling bug) open `STATE` as `state`. Only the
  agent-spelled joined path uses it; `root_refusal` (trusted roots) is
  unchanged. On Linux it can only refuse more.
- Windows grant: a Windows root tab is unfenced, so `launch_prep` records
  `ProjectsGrant::All` and `within_grant` passes everything; the
  `/`-, home- and state-root refusals still apply (`root_refusal` is now
  compiled there; `C:\` has no parent).

Gotchas:
- `cfg(windows)` tests never run here: `junctions_are_refused_never_followed`
  and the two widened `root_mcp_mail`/`mail_store` tests first run on
  Windows CI (`cargo check --tests` for the target is clean).
- The Windows root is opened through `files::canonical_root` →
  `\\?\`-prefixed path; `root_refusal` compares raw-with-raw and
  canonical-with-canonical, so that prefix does not matter.

Gates: `npm run build` ok; `npm test` 730 files / 7527 tests, 2 failed (the
known `MobileHeldPromptStore` pair); `cargo test` 3736 passed (+2 on Linux);
`cargo clippy --all-targets -D warnings` ok; `npm run lint` 0 errors / 28
warnings; `scripts/brand-check.sh` ok; `scripts/privacy-check.sh` ok; `git
diff --check` clean; Windows `cargo check` and `cargo check --tests` ok (no
warnings); Windows `cargo clippy` (lib, and `--all-targets`) the 14
pre-existing findings (A9's), none in this step's files. macOS cross-check
not run (unix arm unchanged apart from the shared `read_capped`).

Flagged for user:
- Never run on Windows: the `32t` manual line is the first live check
  (attach a PDF from a root tab; a junction and `GIT~1` refused).
- Windows has no fence, so this does not bound what the agent could read
  itself — it keeps Tabtivity's read on the agent's behalf to the same
  rules as on Linux (no links, no `.git`, no state, caps). That is the
  reason the old refusal gave; the plan chose to lift it.

### Reviewer

Checked and sound: the file is read from the handle `lookup_file` proved
(`read_capped` on it; no re-open by path); every component, leaf included,
is a single-name `NtCreateFile(FILE_OPEN_REPARSE_POINT)` relative to the held
folder with the reparse attribute refused from the handle's metadata; the
root's leaf too (`open_root`). `:` (ADS, `::$INDEX_ALLOCATION`, drives), 8.3
`~N`, trailing dot/space refused before I/O; backslash, `\\?\`/UNC, leading
`/`, `..` refused by `components` on every platform; device names are not
special in a handle-relative NT open (no DOS name translation), so `CON`/`NUL`
can only open a literal file. `.git` and the secret names are ASCII
case-folded, as NTFS compares. The cap is enforced on the handle. Phone
paths: `child_dir`/`open_file` were the only `open_at` callers and map
`Err(())`/`Ok(None)` to `None` with the same flags and checks — unchanged.
`private_state_paths` lost only its `cfg`. No `nlink` check, as on Unix (the
plan asks for none). Unix arm: only the shared `read_capped`.

Fix (one confirmed bug, also on Linux before this step):
- The joined-path state check used the root only as spelled in the list. A
  root that is a link (junction ancestor, `subst`, symlink on Unix) to an
  ancestor of the state folder passes `root_refusal` and read the state
  through `state/mail/…`. The check now joins onto the canonical root as
  well, like `root_refusal`. Regression test
  `a_linked_root_above_the_state_does_not_reach_it` (unix; failed before).
  Commit ee7faf4f.

Flagged for user:
- Fails closed but with a misleading sentence: any non-NotFound open error
  (a sharing violation on a file another app holds exclusively, access
  denied) is reported as "a link or not a regular file; links … are never
  followed". Also every reparse point is refused, so OneDrive cloud-file
  placeholders and dedup'd files cannot be attached on Windows (the phone's
  📁 behaves the same).
- A root spelled through a UNC admin share (`\\localhost\C$\Users\…`) still
  escapes both the home and the state checks (its canonical form is
  `\\?\UNC\…`, never `C:\…`). The root comes from the trusted list and a
  Windows root tab is unfenced (it can read the state itself), so this is
  defence in depth only.

Gates (after the fix, sequential): `npm run build` ok; `npm test` 7527, 2
failed (the known `MobileHeldPromptStore` pair); `cargo test` 3737 passed
(+1); `cargo clippy --all-targets -D warnings` ok; `npm run lint` 0 errors /
28 warnings; brand-check ok; privacy-check ok; `git diff --check` clean;
Windows `cargo check --tests` ok; Windows clippy the 14 pre-existing (A9's),
none in this step's files.

## A9 — 3.12

Range: `8b1d9f73..` the commit that carries this section on `osfix/a9`
(`git log -1 --format=%h -- docs/macos_windows_completion_handoff.md`; one
commit for the step).

Per file (all lint-only; no behaviour change on any platform):
- `.github/workflows/ci-cd.yml` — `test-windows`: `components: clippy` on
  Setup Rust and a final `Lint backend (clippy, staged)` step,
  `continue-on-error: true`, the same command as macOS. The macOS step's
  comment now says its arms were linted locally through stand-ins (it stays
  staged, decision 9).
- Windows findings (14, all fixed as clippy suggested):
  `commands/apps.rs` (`needless_return` in `list_installed_apps`,
  `sort_by_key`, four `map_or(false, …)` → `is_some_and`, `BI_RGB.0 as u32`),
  `commands/screenshot.rs` (`BI_RGB.0 as u32`), `commands/network.rs`
  (elided lifetimes on the Windows `rows` helper), `platform/windows.rs`
  (`impl Default for WindowsBackend` → `new()`, `is_some_and`),
  `platform/mod.rs` and `services/vm.rs` (`needless_return`),
  `services/project_runtime.rs` (redundant closure → the fn path; this one
  was shared with macOS).
- macOS findings (A7's 12 were 10 lib + 2 test-only after the shared ones;
  all fixed): `apps.rs` (`needless_return`, `read_dir(root)`, `get(key)`,
  the macOS `sort_by_key`), `screenshot.rs` (unused `Command` import),
  `subwindow.rs` and `lib.rs` (`ns as *mut c_void` same-type cast → pass
  `ns_window_id` directly), `platform/mod.rs` and `vm.rs` (`needless_return`),
  `services/agent_fence.rs` (`KEYRING_SYSCALLS` / `keyring_seccomp_filter`
  were `cfg(any(linux, all(test, unix)))` but every user is Linux-only →
  narrowed to `cfg(target_os = "linux")`; dead code in the macOS test build).
- `commands/network.rs` `local_ssh_link` and `services/net_usage.rs` — the one
  `allow`: `#[cfg_attr(target_os = "macos",
  allow(clippy::default_constructed_unit_structs))]` with a comment.
  `SsDump` is a unit struct only on macOS; `SsDump::default()` is the one
  spelling Linux (a tuple struct) also compiles, so clippy's fix would break
  Linux.

Choices where the plan left room:
- Fixed the macOS findings too (plan only required Windows): same lint
  classes, same files, all compile-checked through the stand-ins. The macOS
  CI step still stays staged — the stand-ins never link and a real Mac has
  not run it.
- `Default` for `WindowsBackend` rather than an `allow`: `new()` only reads
  the process id.

Gotchas:
- Local toolchain is rustc/clippy 1.97.1 (2026-07-14); CI uses latest
  stable, likely one or two releases newer. `rustup check` cannot run here
  (read-only `~/.rustup` under the fence), so a newer clippy may print new
  lints on the first Windows/macOS run — that is what `continue-on-error`
  is for.
- The vendored `src-tauri/patches/tauri-runtime-wry` prints 5 "unnecessary
  `unsafe` block" warnings when built for macOS (`src/window/macos.rs`). A
  dependency's warnings do not fail `-D warnings`; not touched.
- macOS stand-ins (check only, never link) as in A7: a `cc` that truncates
  its `-o` file and an `ar` that truncates the `.a`;
  `CC_aarch64_apple_darwin=<dir>/cc AR_aarch64_apple_darwin=<dir>/ar`.
  Delete the untracked `src-tauri/gen/schemas/macOS-schema.json` afterwards.

Gates (sequential): `npm run build` ok; `npm test` 730 files / 7527 tests,
2 failed (the known `MobileHeldPromptStore` pair); `cargo test` 3737 passed;
`cargo clippy --all-targets -D warnings` ok; `npm run lint` 0 errors / 28
warnings; brand-check ok; privacy-check ok; `git diff --check` clean;
Windows `cargo check` and `cargo check --tests` ok (no warnings); Windows
`cargo clippy --all-targets -D warnings` **0 findings**; macOS `cargo check
--tests` ok (stand-ins) and macOS `cargo clippy --all-targets -D warnings`
**0 findings** in this crate; YAML parses (PyYAML 6.0.3).

Flagged for user:
- Neither staged step has run on a real runner. After the first green
  `test-windows` (and `test-macos`) run, delete their `continue-on-error`
  lines to make them real gates.
- CI's newer stable clippy may still report lints 1.97 does not know.
