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

### Flagged for user

- None.
