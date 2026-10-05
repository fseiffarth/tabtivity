# Done Groups Archive

Code-complete groups, collected here per [CLAUDE.md](../CLAUDE.md)'s numbering convention (item numbers stay global and stable across the whole plan; group letters are never reused). **All groups below are ✅ Done with passing 🤖 automated tests** (see exceptions noted per group); **🖐️ manual/runtime QA is still pending across the board** — see the Status legend in [../TODO.md](../TODO.md).

`Group N` and `Group U` are done but not yet renumbered into the `D.x` sequence; kept under their original letters here so existing references (commits, docs) stay valid.

---

## Group D.1 — Right Panel: File Tree & Navigation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx`, `fileUtils.ts`, `RightPanel.tsx`, `src/styles/themes.css`. Backend create/delete commands already exist in `commands/projects.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

1. ✅ **Create file / folder from right-click.** Added "New File" + "New Folder"
   entries to the entry context menu, plus an empty-area context menu so files
   can be created in an empty folder. Both reuse the `window.prompt` pattern and
   call the existing `create_file` / `create_dir` commands, then reload.
   - *Test (e.g.):* right-click a folder → "New File", type a name → the
     file appears in the tree **and** on disk; repeat via the empty-area menu
     inside an empty folder to confirm creation there too.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

2. ✅ **Show long file/folder names in full.** Added a native `title={e.name}` to
   the `.file-name` span so the full name shows on hover (CSS ellipsis kept).
   - *Test (e.g.):* create a file with a very long name → the row shows a
     truncated name with ellipsis, and hovering it surfaces the full name in a
     native tooltip.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

3. ✅ **Show parent folders when inside a subfolder.** Replaced the single
   "↑ .." button with a breadcrumb trail (up arrow, project-root `⌂` crumb, and
   each path segment separated by `/`), each segment clickable to jump directly.
   - *Test (e.g.):* navigate two levels deep → breadcrumb shows
     `⌂ / sub / subsub`; click the middle `sub` crumb → tree jumps to that folder
     and the breadcrumb trims accordingly.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

---

---

## Group D.2 — Right Panel: Git Status Markers ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/git.rs` (`git_file_statuses`), `FileTree.tsx` (`STATUS_COLOR`, `GitMarker`), `fileUtils.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

4. ✅ **Fix incorrect git colors.** Rewrote the porcelain parsing so the
   working-tree column (Y) decides "modified" before the index column (X) decides
   "staged" — partly-staged files like `MM` now read as modified (red) rather
   than masquerading as fully-staged. Bubbling priority is now
   modified > untracked > staged > unpushed > ignored.
   - *Test (e.g.):* stage a file then edit it again (porcelain `MM`) →
     its tree marker is red (modified), not orange (staged), and the containing
     folder bubbles up to red.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

5. ✅ **Richer marker scheme.** `git_file_statuses` now also marks
   committed-but-unpushed files via `git log @{u}..`. Markers: gitignored → gray
   ✕ glyph; unstaged/untracked → red bar; staged → orange bar; unpushed → green
   ↑ glyph; clean/pushed → no marker. (Ignored uses a gray ✕ rather than red to
   avoid flooding the tree with alarm-colored marks on `target/`, `node_modules/`
   etc.; trivially switchable in `STATUS_COLOR`.)
   - *Test (e.g.):* set up one file in each state (ignored, untracked,
     staged, committed-but-unpushed, clean) → each shows the right glyph/color:
     gray ✕, red bar, orange bar, green ↑, no marker respectively.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

6. ✅ **Show `.gitignore` in the tree.** `visibleEntries` now keeps `.gitignore`
   visible by default while still honoring the `panel_hidden_*` filters.
   - *Test (e.g.):* in a project with a `.gitignore`, confirm it stays
     visible in the tree even with default hidden-file filtering on, while other
     `panel_hidden_*` matches remain hidden.
   - [x] 🤖 Automated test — `GitignoreVisible.test.ts`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

---

---

## Group D.3 — Right Panel: Git History & Commit UI ✅ Done · 🧪 Untested
*Files: `src/components/files/GitHistory.tsx` (new), `RightPanel.tsx` (new "Git"
view), backend commands `git_log` / `git_branches` / `git_checkout` /
`git_commit_message` / `git_reword_head` in `commands/git.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

7. ✅ **Git history view.** New "Git" tab in the right-panel header shows the
   current branch, clickable local/remote branch pills (checkout), and a commit
   list (short hash, subject, ref badges, relative date; HEAD marked). Backend
   `git_log`, `git_branches`, `git_checkout` added.
   - *Test (e.g.):* open the Git tab → current branch is shown, the commit
     list matches `git log`, HEAD is marked, and clicking another branch pill
     checks it out (tree/branch label update).
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

8. ✅ **Click a commit → commit-message window.** Clicking a commit opens a modal
   showing its full message. For HEAD it is editable with a "Generate (agent)"
   action (reuses `git_generate_commit_message`) and "Save (amend)"
   (`git_reword_head`); older commits are read-only. A "Checkout" action checks
   out the commit (detached). Full message fetched via `git_commit_message`.
   - *Test (e.g.):* click HEAD → modal is editable, edit + "Save (amend)"
     rewrites the commit message; click an older commit → read-only; "Checkout"
     puts the repo in detached HEAD at that commit.
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

---

---

## Group D.4 — Bottom Panel: Project Pill polish ✅ Done · 🧪 Untested
*Files: `src/components/projects/ProjectPill.tsx`, `src/stores/activity.ts` (new),
`src/components/layout/AppShell.tsx`, `ProjectSwitcher.tsx`, `src/stores/projects.ts`,
backend `commands/terminal.rs` (`project_cpu_percent`), `commands/projects.rs`
(`set_project_description`), `src-tauri/src/sysstat.rs` (new). Test:
`src/__tests__/PillRunningIndicator.test.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green; #11 CPU% core helpers only) · 🖐️ manual ❌ (runtime QA pending)

9. ✅ **Running-task indicator on pills.** New `activity` store derives a
   per-scope "busy" flag from live PTY output: a single global `terminal-output`
   listener in `AppShell` stamps each PTY's last-output time (covers backgrounded
   projects too), and a 300 ms tick recomputes `busyByScope`. Busy pills show the
   three-dot `OrbitSpinner` tinted green (`.pill-running-spinner`).
   - *Test (e.g.):* start a long-running command in a **backgrounded**
     project's terminal → that pill shows the green spinner within ~300 ms; when
     output stops, the spinner clears shortly after.
   - [x] 🤖 Automated test — `PillRunningIndicator.test.ts`
   - [ ] 🖐️ Manual test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

10. ✅ **Right-click → change description.** Pill context menu gains "Edit
    description" opening a small textarea dialog. Saving calls the new
    `set_project_description` command, which writes both `projects.json` (the
    pill list) and the project's `project.json`, then mirrors the cleaned value
    into the store.
    - *Test (e.g.):* right-click a pill → "Edit description", save new
      text → both `projects.json` and that project's `project.json` are updated
      on disk and the hover popup shows the new description.
    - [x] 🤖 Automated test — `projects_commands.rs::set_project_description_writes_both_projects_json_and_project_json`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

11. ✅ **Hover → per-project CPU %.** Hover popup now shows live CPU%, polled
    every 1.5 s while open. New `project_cpu_percent` command (backed by the
    `sysstat` `/proc` module) resolves the project's PTY ids → child PIDs +
    descendants and samples jiffies over a 300 ms window. CPU-only by design;
    per-process GPU isn't reliably attributable on Linux, so the existing Ollama
    VRAM tracking stays as the GPU signal. No-op (returns 0) off Linux.
    - *Test (e.g.):* hover a pill whose project runs a CPU-busy process →
      popup shows a non-zero CPU% refreshing ~every 1.5 s; an idle project reads
      ~0%; on non-Linux it returns 0 without erroring.
    - [x] 🤖 Automated test — *partial:* `sysstat.rs` unit tests (clk_tck, descendant_pids self-inclusion/empty, sum_jiffies live+dead pid); live % readout is manual
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

12. ✅ **Suppress default webview reload/inspect on right-click.** The
    `.project-switcher` container now `preventDefault`s `contextmenu`, so a right-click
    anywhere on the bar surfaces only our pill menu, never Reload/Inspect.
    - *Test (e.g.):* right-click empty space on the project switcher and on a
      pill → only the custom menu appears; the default webview Reload/Inspect
      context menu never shows.
    - [x] 🤖 Automated test — `ProjectSwitcherContextMenu.test.tsx`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.5 — Branding ✅ Done · 🧪 Untested
*Files: `src/assets/logo.svg` (new), `src/components/layout/HeaderBar.tsx`, `src-tauri/icons/*`.*
🧪 Tested: 🤖 automated — N/A (purely visual) · 🖐️ manual ❌ (icons/header not visually verified in a live build)

25. ✅ **Redraw the Tabtivity logo in SVG.** Recreated the logo as a clean,
    symmetric vector (`logo.svg`): green circuit "tree of life" ring, split
    trunk, mirrored branch traces with node terminals, and the gold spark — left
    half authored and mirrored across the centre line. Header now imports the SVG
    (`logo.png` removed). OS app icons (`32x32`, `128x128`, `128x128@2x`,
    `icon.ico`, `icon.icns`) regenerated from the vector via `tauri icon`, which
    also fixed the previously mis-sized (all 650×650) raster icons.
    - *Test (e.g.):* launch a packaged build → the header renders the new
      SVG logo crisply, and the OS app/taskbar icon shows at correct sizes (not a
      stretched 650×650 blob).
    - [ ] 🤖 Automated test — *N/A: purely visual; manual only*
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.6 — Drag & Drop Reordering ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (already has a `reorder(from, to)` action),
`src/components/layout/CenterPanel.tsx` (tab bar — no drag handlers yet);
`src/stores/projects.ts` (projects carry a `position` field and are sorted by
it, but there is no reorder/persist action), `ProjectSwitcher.tsx`/`ProjectPill.tsx`,
backend `save_projects`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

26. ✅ **Drag-and-drop tab reordering.** Tabs in `TabBar.tsx` are now `draggable`
    with HTML5 drag handlers that call `useTabsStore.reorder(from, to)` on drop.
    Persistence is automatic — `CenterPanel`'s debounced `saveLayout` effect runs
    whenever `tabs` changes. Drag feedback via `.tab.dragging` / `.tab.drag-over`.
    - *Test (e.g.):* drag a tab to a new slot → order updates with drag
      feedback; reopen the app → the new tab order persisted (saveLayout fired).
    - [x] 🤖 Automated test — `TabReorder.test.ts`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

27. ✅ **Drag-and-drop project ordering.** Pills in `ProjectPill.tsx` are now
    `draggable` (source id carried in `dataTransfer`); dropping on another pill
    calls the new `reorderProjects(fromId, toId)` action in `projects.ts`, which
    splices the active-pill order, renumbers every project's `position` with
    gap-spaced values (active pills first, inactive after), and persists via
    `save_projects`. Drag feedback via `.project-pill.drag-over`.
    - *Test (e.g.):* drag one pill onto another → pills reorder, `position`
      values are renumbered (active first, inactive after) and written via
      `save_projects`; restart → order survives.
    - [x] 🤖 Automated test — `ProjectReorder.test.ts`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.7 — Right Panel: Hidden Files Section ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (the `separateScaffold` split at
~426-480 and the "scaffold" `file-tree-section-divider`), `fileUtils.ts`
(`visibleEntries`, `STANDARD_PROJECT_FILES`), `src/styles/themes.css`.*
🧪 Tested: 🤖 automated ✅ (`HiddenFilesSection.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

29. ✅ **Collapsible hidden-files section under scaffold.** Keep the existing
    show/hide filtering (`showHidden` toggle + `hiddenEndings`/`hiddenPaths` in
    `visibleEntries`) exactly as-is. **Additionally**, when a scaffold section is
    shown, render a third grouped section **below** the scaffold divider that
    gathers the hidden folders/files, collapsed (minimized) by default with a
    click-to-expand header. This is an addition to the existing
    `separateScaffold` rendering (a parallel `hidden` bucket + a collapsed
    `<details>`-style divider), not a replacement of the binary show/hide
    toggle — so hidden items stay discoverable without flooding the tree, and
    the toggle still works for users who want them inline or fully hidden.
    - *Test (e.g.):* in a project with hidden files, the scaffold view
      shows a collapsed "hidden" section below the divider; clicking its header
      expands it; the existing show/hide toggle still works independently.
    - [x] 🤖 Automated test — `HiddenFilesSection.test.ts`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.8 — Right Panel: Persist Script-Run Animation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (`runningScripts` state + the
`script-finished` listener at ~136, `runShellScript`, `.file-run-spinner`),
`src/components/layout/RightPanel.tsx` (renders `<FileTree>` only `{open && …}`).
Related to the run-detached backend `run_script_detached` in `commands/apps.rs`.*
🧪 Tested: 🤖 automated ✅ (`ScriptRunState.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

34. ✅ **Keep the `.sh` run animation alive when the right panel hides.** Today
    `FileTree` is mounted only while the panel is open (RightPanel
    `{open && (<FileTree…>)}`), so hiding the panel unmounts the tree and drops
    both the local `runningScripts` set and the `script-finished` subscription —
    when reopened, a still-running script shows no spinner and a completed run is
    never reflected. Lift the running-scripts state and the `script-finished`
    listener out of `FileTree` into a persistent owner (a small store like
    `activity.ts`, or an `AppShell`-level listener) so the run animation/state
    survives panel hide/show and the button re-renders correctly on reopen.
    - *Test (e.g.):* run a long `.sh`, hide the right panel, reopen →
      spinner is still active; let it finish while hidden → on reopen the button
      shows the finished (non-spinning) state.
    - [x] 🤖 Automated test — `ScriptRunState.test.ts`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.9 — Center Panel: Free Tab Arrangement / Grid View ✅ Done · ⛔ Superseded by D.11
*The per-scope auto-grid (`grid`/`gridByScope`/`toggleGrid`/`setGrid` + ▦ button)
was **removed** and replaced by the tiling split-subwindow model in Group D.11.
`TerminalView`'s `visible`/`focused` prop split survives and is reused there.
`GridView.test.ts` now only asserts the old grid API is gone.*
🧪 Tested: 🤖 automated ✅ (`GridView.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

35. ✅ ⛔ **Free arrangement of tabs / grid view — superseded.** The original
    per-scope auto-grid (columns = `ceil(sqrt(n))`) is gone; tab arrangement is
    now the directional tiling split model (Group D.11 / #36). The reusable
    `TerminalView` `visible`/`focused` prop split and the all-scopes-mounted pane
    approach carried over. `GridView.test.ts` was rewritten to assert the grid
    store API no longer exists.
    - [x] 🤖 Automated test — `GridView.test.ts` (asserts removal)
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.10 — Project Model, Import & Publishing ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/projects.rs` (`normalize_git_type`,
`ImportProjectRequest.skip_scaffold`, create/import defaults + read-time
migration), `src-tauri/src/commands/github.rs` (new `github_publish`),
`lib.rs`/`commands/mod.rs` (registration), `ProjectSwitcher.tsx` (push-target select +
skip-scaffold checkbox), `ProjectPill.tsx` (Publish window + menu),
`src/stores/projects.ts` (`publishProject`), `src/types/index.ts`,
`themes.css` (`.skip-scaffold-row`). Tests: `projects_commands.rs`
(`import_project_skip_scaffold_…`), unit tests for `normalize_git_type` and
`shell_quote`.*
🧪 Tested: 🤖 automated ✅ (suite green; #22 publish = shell_quote only) · 🖐️ manual ❌ (`github_publish` runtime QA pending)

20. ✅ **No-scaffold option for import.** `ImportProjectRequest` gained a
    `skip_scaffold` flag (default false); `finish_import` now gates the
    `scaffold_project` call (and its `git init`) on it, still writing
    `project.json` so the project registers. The import dialog shows a "Skip
    scaffolding (project already has its own files)" checkbox that also hides the
    scaffold-fill guidance and suppresses the scaffold-fill agent tabs.
    - *Test (e.g.):* import an existing repo with "Skip scaffolding"
      checked → no `AGENTS.md`/`CLAUDE.md`/etc. added and no `git init`, but
      `project.json` is written so it registers (cf. `import_project_skip_scaffold_…`).
    - [x] 🤖 Automated test — `projects_commands.rs::import_project_skip_scaffold_does_not_add_missing_scaffold_files`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

21. ✅ **Rename public/private → local/remote (push-target axis).** `git_type`
    now models the git **push** target — distinct from the SSH **work**-remote —
    with three values: `local`, `remote-private`, `remote-public`. New projects
    default to `local`. A `normalize_git_type` helper migrates legacy values
    (private → remote-private, public → remote-public) on read in `get_projects`
    / `load_project` and canonicalizes writes. The dialog's "Git push target"
    select offers the three options.
    - *Test (e.g.):* a legacy project with `git_type: "private"` loads as
      `remote-private` via `get_projects`; a brand-new project defaults to
      `local` (cf. the `normalize_git_type` unit test).
    - [x] 🤖 Automated test — `commands/projects.rs` normalize_git_type unit tests
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

22. ✅ **"Make repo public" publish flow.** New `github_publish(project_id,
    visibility)` command shells out to `gh repo create <name> --public|--private
    --source=. --remote=origin --push`. For SSH work-remote projects it runs over
    `ssh` on the host where the bytes live (reusing `ssh_base_args`/`validate_arg`
    + single-quoted remote argv). On success it records `git_type =
    remote-<visibility>` in both `projects.json` and `project.json`. Surfaced via
    a "Publish to GitHub…" entry in the project-pill context menu opening a
    visibility-picker window; the store's `publishProject` mirrors the new push
    target into state. Requires `gh` installed + authenticated. **Runtime QA
    pending** (agents can't launch Tabtivity).
    - *Test (e.g.):* on a local project, "Publish to GitHub…" → pick
      public → `gh repo create` runs and `git_type` flips to `remote-public` in
      both json files; for an SSH project the command runs over `ssh` on the host.
    - [x] 🤖 Automated test — *partial:* `commands/github.rs` shell_quote unit tests (argv escaping only; full gh/ssh publish flow is manual)
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

23. ✅ **GitLab support alongside GitHub.** `commands/github.rs` renamed to
    `commands/git_publish.rs`; `github_publish` generalized to
    `publish_project(project_id, provider, visibility)` with a `Provider`
    enum (`github`→`gh`, `gitlab`→`glab`). GitHub keeps `gh repo create …
    --source=. --remote=origin --push`; GitLab runs `glab repo create …
    --remoteName origin` then an explicit token-authenticated `git push -u origin
    HEAD` (glab has no `--source/--push`), reusing the inline credential-helper
    pattern (`oauth2` username, `GITLAB_TOKEN` for the CLI). Provider recorded in a
    new `Project.git_provider` field (mirrored into `projects.json`). Publish
    window gained a provider picker; pill label + menu, settings/hosting
    placeholders, lessons, README and DOCUMENTATION updated. **Runtime QA pending**
    (needs `glab` installed + authenticated; agents can't launch Tabtivity).
    - *Test (e.g.):* on a local project, Publish → GitLab → private runs `glab repo
      create … --private --remoteName origin` then `git push`, and `git_type` flips
      to `remote-private` with `git_provider: "gitlab"` in both json files.
    - [x] 🤖 Automated test — `commands/git_publish.rs` provider-parse + remote-script unit tests (argv only; full glab/ssh flow is manual)
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

209. ✅ **`AGENTS.md` is the canonical scaffold; `CLAUDE.md`/`GEMINI.md` are
    pointers.** The three agent docs used to be interchangeable one-line stubs,
    so guidance either got written three times or (in practice) into whichever
    file the agent of the day reads. `AGENTS.md` now carries the actual template
    — Project / Running / Conventions sections plus a link block covering both
    sibling agent files and every other scaffold doc (README, DOCUMENTATION,
    ROADMAP, TODO, STATUS) — and `CLAUDE.md`/`GEMINI.md` are pointers that
    `@AGENTS.md`-import it (real import syntax in both CLIs, so the text is
    loaded, not merely referenced) and link the other agent files. Applies on
    **new project and import** alike, since both go through `scaffold_project`.
    A **repair** additionally upgrades an agent doc still byte-identical to its
    old stub (or empty) — provably untouched text, reported as `updated_files`
    and summarized as "updated …" — while anything a user or agent wrote is left
    alone; `project_scaffold_missing` counts a legacy stub as missing so the
    pill's tag agrees with what a repair would do. The agent-fill prompt now
    tells the filling agent to keep the pointers pointing.
    - *Test (e.g.):* create a project → `AGENTS.md` links `./CLAUDE.md` +
      `./GEMINI.md` and `CLAUDE.md` contains a bare `@AGENTS.md` line; repair a
      project whose `CLAUDE.md` is still `# Claude Context` → it becomes the
      pointer template, while a `GEMINI.md` the user wrote is untouched.
    - [x] 🤖 Automated test — `commands/projects.rs::agent_docs_point_at_agents_md_and_link_each_other`, `::legacy_stub_detection_only_matches_untouched_agent_docs`, `::repair_upgrades_untouched_legacy_agent_stubs`, `::repair_leaves_current_agent_docs_alone`; `ScaffoldRepair.test.ts`, `ScaffoldAgentFill.test.ts`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.11 — Center Panel: Tiling Split Subwindows ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (layout-tree model: `SplitNode`/`GroupNode`,
`splitWithTab`/`moveTab`/`reorderInGroup`/`resizeSplit`/`removeTab` collapse,
`serializeTree`/`deserializeTree`, per-scope `layoutByScope`/`focusedGroupByScope`),
`src/components/layout/CenterPanel.tsx` (recursive split render + measured-rect
pane positioning + panel-wide drop tracking), `src/components/tabs/Subwindow.tsx`
(per-group frame + L/R/T/B/center drop zones), `src/components/tabs/TabBar.tsx`
(per-group bar, cross-group drag payload `{key, fromGroup}`),
`src/components/layout/HeaderBar.tsx` (global tab bar removed), `src/stores/projects.ts`
(threads `tabGroups` through project switch via shared `serializeTree`),
`src/styles/themes.css` (`.subwindow`, `.split`/`.split-divider`, `.drop-zone`).
Backend: `schema/project.rs` `tab_groups`, `commands/projects.rs::save_tab_layout`,
`services/terminal_service.rs`, `schema/session.rs`, `services/project_runtime.rs`.
Tests: `src/__tests__/SplitLayout.test.ts`.*
🧪 Tested: 🤖 automated ✅ (`SplitLayout.test.ts` green, 85 vitest + cargo) · 🖐️ manual ❌ (runtime QA pending)

36. ✅ **Tiling split subwindows (directional drag-drop splits).** Reworked the
    center panel from one header tab bar + auto-grid into a tiling layout of
    subwindows. Each subwindow (group) owns its tabs and renders its own tab bar;
    dragging a tab onto another subwindow's edge (L/R/T/B) splits that direction
    into a new subwindow, onto its center moves the tab in. Splits resize via
    draggable dividers (`resizeSplit`, clamped, divider-pair math). The layout is
    a per-scope tree (`layoutByScope`); flat tab payloads stay per-scope so PTYs
    never unmount. `removeTab`/`moveTab`/`splitWithTab` collapse emptied groups
    and lone splits and keep focus + `activeKey` on a surviving group. Persisted
    as `tab_groups` in `project.json` alongside the flat `tab_layout`, round-trips
    through project switch (`switch_project_runtime`); absent → single group
    (legacy projects). **Backend rebuild/restart required** for `tab_groups`
    persistence (per CLAUDE.md; agents can't launch Tabtivity).
    - *Test (e.g.):* drag a tab onto a subwindow's right edge → a 2-way row split
      with the dragged tab in a new group sized 50/50; close its only tab → split
      collapses back to one group with focus on the survivor; reload restores the
      tree from `tab_groups`.
    - [x] 🤖 Automated test — `SplitLayout.test.ts` (splits/collapse/move/resize/load)
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.12 — Layout fix: project switcher in the top header ✅ Done · 🧪 Untested
*Files: `src/components/layout/HeaderBar.tsx` (`header-center`),
`src/components/layout/ProjectSwitcher.tsx` (renamed from the old `BottomBar`),
`src/components/layout/AppShell.tsx`, `RightPanel.tsx`, `themes.css`.*
🧪 Tested: 🤖 automated ✅ (`ProjectSwitcherContextMenu.test.tsx` green) · 🖐️ manual ❌ (runtime QA pending)

14. ✅ **Stop bottom/right panel intersection.** Resolved by moving the project
    switcher out of the bottom overlay into the top header (`HeaderBar`
    `header-center`); the old `BottomBar` component became `ProjectSwitcher.tsx`.
    With no bottom bar there is nothing left to overlap the right panel, and the
    pill menus now open downward.
    - *Test (e.g.):* the project pills render in the top header; revealing the
      right panel no longer collides with a bottom bar.
    - [x] 🤖 Automated test — `ProjectSwitcherContextMenu.test.tsx`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.13 — Right Panel: Pin / Dock Option ✅ Done · 🧪 Untested
*Files: `src/components/layout/AppShell.tsx` (hover-reveal/auto-close timers
`handleBodyMouseMove`/`scheduleClose`, `rightPinned` state), `RightPanel.tsx`
(`right-panel-header` pin button), `src/stores/settings.ts`
(`right_panel_pinned`), `src/styles/themes.css` (`.right-panel`/`.app-body`).*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

37. ✅ **Pin the right panel open.** A 📌 toggle in the `right-panel-header`
    keeps the panel persistently open instead of auto-hiding on mouse-leave; when
    pinned the hover-reveal/auto-close timers are suppressed and the panel takes
    layout space (no overlap of the center terminal). The pinned flag persists in
    `settings.json` (`right_panel_pinned`) and is restored on launch.
    - *Test (e.g.):* click the pin → panel stays open after the cursor leaves;
      center reflows (no overlap); toggle off → reverts to hover-reveal; restart →
      pinned state restored.
    - [x] 🤖 Automated test — covered by the right-panel suite
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

## Group D.14 — File → Tab: In-App Viewers & Embedded Tabs (Phase 1) ✅ Done · 🧪 Untested
*Files: drag source `src/components/files/FileTree.tsx`, drop targets
`src/components/tabs/TabBar.tsx`/`Subwindow.tsx` + `commitFileDrop.ts`,
`src/stores/tabs.ts` (`"embed"` tab kind, `viewer`/`embedExec`), in-app viewers
`src/components/embed/FileViewerPane.tsx` + `EmbedPane.tsx`,
`src/components/files/markdown.ts`, `fileUtils.ts` (`internalViewerFor`),
backend `commands/apps.rs` (`embed_capability`, default-app resolution),
`commands/tex.rs` (`tex_capability`/`compile_tex`). Tests:
`FileDropAddsEmbedTab`/`FileDropEmptyFirstTab`/`FileDropSplitsSubwindow`,
`EmbedCapabilityGate`, `InternalViewer`, `Markdown`, `embed_capability_tests.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

40. ✅ **Drag a file from the right panel into a (sub)window's tab bar to open it
    in a tab (Phase 1).** Dragging a file row onto a subwindow's tab bar opens a
    new `"embed"` tab **named after the file**. Two backends: files with a
    built-in viewer (`internalViewerFor` → PDF, image, markdown, or text) render
    **in-app** via `FileViewerPane` — a zoom/pan image view, a PDF iframe, a
    markdown Edit/Preview toggle, and an editable code editor (line-number gutter,
    Tab/Shift+Tab indent, Ctrl+S save). Other files open in their external default
    app via `EmbedPane`, gated on an `embed_capability` check. Only in-app
    `viewer` embeds persist/restore across restart. TeX files additionally get a
    compile affordance when a LaTeX engine is on `PATH` (`tex_capability` /
    `compile_tex`). **Phase 2 (live X11-reparented frameless embedding) deferred**
    — see `docs/group_k_plan.md`.
    - *Test (e.g.):* drag `notes.md` onto a subwindow's tab bar → a `notes.md`
      tab opens rendering the markdown in-app; drag a `.png` → zoomable image
      tab; on an unsupported OS/app a non-viewer file opens externally as before.
    - [x] 🤖 Automated test — `FileDrop*`/`InternalViewer`/`Markdown`/`EmbedCapabilityGate`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

*This is an organizational plan. Pick an item by its number and I'll produce a
focused implementation plan + changes for just that item.*

---

## Group N — Native Calendar ✅ Done · 🧪 Untested
*Files: `src-tauri/src/schema/calendar.rs`, `src-tauri/src/commands/calendar.rs`,
`src/components/calendar/*`, `src/stores/{calendar,alarms}.ts`,
`src/lib/{calendarTime,recurrence,ics,alarms,calendarCategories}.ts`. Brought the
month-grid-only calendar up to Thunderbird-class features. The store is global —
one `calendar.json`, shown by every calendar tab in every scope.*

N1. **Event model v2 + migration.** `{date, time}` → `{start, end, all_day}` with
    exclusive ends, plus location/category/status/rrule/alarms, and calendars +
    tasks alongside. `calendar.json` became an object; the legacy bare array still
    loads and is migrated on read (`CalendarFile`).
    - [x] 🤖 Automated test — migration, CRUD, orphan refile (`commands/calendar.rs`)

N2. **Views.** Day / week / multiweek / month / agenda / tasks, with a mini-month
    + calendar list sidebar, a search box, and keyboard nav (←/→, T, N, 1-6).
    Multi-day events render as spanning bars; day/week supports drag-to-create,
    drag-to-move and edge-drag-to-resize (pointer events — HTML5 DnD is unusable
    under WebKitGTK).
    - [ ] 🧪 Manual — drag/resize in week view; multi-day bars in month view

N3. **Recurrence.** Daily/weekly/monthly/yearly with interval, byweekday,
    bymonthday, until/count. Editing or deleting one occurrence of a series
    prompts "this occurrence / all occurrences" (exdates + per-occurrence
    overrides, keyed by the rule-generated start).
    - [x] 🤖 Automated test — `src/__tests__/Recurrence.test.ts` (39 cases)

N4. **Reminders.** Fire on **both** channels: an OS notification
    (`tauri-plugin-notification`) so it lands when Tabtivity is unfocused, and an
    in-app popup with snooze/dismiss, mounted in `AppShell` so it shows on any
    tab. Fired alarms are keyed and persisted, so one never fires twice.
    - [x] 🤖 Automated test — `src/__tests__/Alarms.test.ts` (fire-once, snooze)
    - [ ] 🧪 Manual — confirm the OS notification actually appears on KDE/Wayland

N5. **Multiple calendars, categories, tasks, ICS.** Named/colored/toggle-visible
    calendars; a category→color palette; VTODO tasks (due, priority, % complete);
    and ICS import/export through `calendar_read_ics`/`calendar_write_ics` —
    deliberately narrow, extension- and size-guarded commands, because the general
    `read_file_text`/`write_file_text` are confined to the current project and
    that confinement is worth keeping.
    - [x] 🤖 Automated test — `src/__tests__/Ics.test.ts` (round-trip, folding, guards)
    - [ ] 🧪 Manual — import a real .ics from Thunderbird/Google and check fidelity

N6. **Deferred.** Timezone support (everything is floating local time; a `TZID`
    we do not understand is dropped rather than guessed at), CalDAV/URL
    subscriptions, ordinal BYDAY (since done: X#2318), and
    per-occurrence category/status overrides.

---

## Group U — Usage Stats & Daily Recap ✅ Done · 🧪 Untested

A local usage-counter store (`usage_stats.json`) plus a recap dialog that opens on
the first launch of each day and from a Settings button. Answers "you used 4 agent
tabs today (2 Claude, 1 Codex, 1 qwen3), asked them 37 things, and
created/modified/deleted 12/47/3 files", with Day / Week / Month windows and time
per project. Everything is counted locally; nothing is sent anywhere.

Design notes worth keeping in mind before extending it:

- The store is `schema::usage_stats`, modelled on `schema::net_usage` (same
  hour+day buckets, same prune-on-save). Its payload is an **open string-keyed
  counter map**, so a new statistic costs one const in `metric` (mirrored in
  `src/lib/usageMetrics.ts`) and one render line — no schema migration.
- Time, network bytes and git are **not** counted into it. They are read from
  `time_summary.json`, `net_usage.json` and `git log` at recap time, so they can
  never drift from their sources.
- Tab opens are counted in the frontend's `addTab`, **not** at `pty_spawn`: the
  backend spawn fires again for every resumable agent tab respawned on relaunch,
  which would report a fresh "agent tab opened" each morning.

86. **Prompt counting is a keystroke heuristic.** `lib/agents/promptCount.ts` counts a
    submit as "Enter with content typed since the last Enter". It covers all
    eleven agents and every local model without reading another app's data dir,
    but an Enter inside an agent's multi-line editor buffer over-counts. If Claude
    and Codex ever expose a supported per-session message count, prefer it for
    those two and keep the heuristic as the fallback for the rest.
    - [x] 🤖 Automated test — `src/__tests__/PromptCount.test.ts` (arrow keys,
      Ctrl-C, bare Enter, paste-then-Enter, per-PTY independence).
    - [ ] 🖐️ Manual test — send N prompts to a Claude tab, confirm the recap says N.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

87. **File churn is local-filesystem only.** The recursive `notify` watcher
    (`services::usage_stats`) cannot see an SFTP tree, so a remote project is
    counted only through its **local mirror**, and one without a mirror records
    nothing. The recap states this rather than showing a misleading zero. Revisit
    if a remote-side watcher (inotify over SSH) is ever worth the complexity.
    - [x] 🤖 Automated test — `classify_fs_event` + `is_ignored` + `Debouncer`
      cover create/modify/delete, every ignore rule, and burst collapsing.
    - [ ] 🖐️ Manual test — create/edit/delete files, confirm the counts match; run
      a `cargo build` and confirm `target/` churn does NOT show up.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

88. **One watcher at a time.** Only the *active* project's tree is watched, so
    churn in a background project is not counted. Watching every open project
    would mean an inotify tree per project. Reconsider if per-project file stats
    while multitasking turn out to matter.
    - [ ] 🖐️ Manual test — switch projects, confirm the watcher follows.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

89. **Buckets are UTC.** Matching `time_summary.json` and `net_usage.json`, so all
    three line up. A late-night session lands in "tomorrow" for users well west of
    UTC. Fixing it means a timezone-aware bucket key across all three stores.
    - [ ] 🖐️ Manual test — confirm the recap's day matches the timer's day.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

90. **Only the recap reads the counters.** `usage_summary` already returns
    per-project buckets and the hour buckets are recorded but only used for the
    Day sparkline. Cheap follow-ups if wanted: a per-project stats view, an
    all-time "since you started using Tabtivity" panel, and streaks.
    - [ ] Not started.

---

## Group W — Native Print Manager ✅ Done · 🧪 Untested

*Files: `src-tauri/src/commands/printing.rs`, `src/lib/window/printing.ts`,
`src/types/printing.ts`, `src/components/printing/PrintManagerPane.tsx`, plus the
tab wiring (`stores/tabs.ts`'s `PRINTING_TAB_CMD` / `printing` kind,
`components/tabs/{TabPane,TabBar,NewTabMenu,newTabItems,TabHoverCard}`) and the
role retirement in `components/layout/GlobalAppBar.tsx`.*

W1. **The print manager became a tab.** `print_manager` was a **global-app
    slot** — a toolbar button that launched whatever external printer GUI the
    user had configured. What sat behind that button is a list of printers, a
    queue and four verbs, so it is now Tabtivity's own tab (⎙ in the new-tab menu,
    one per scope), and the role joined `RETIRED_GLOBAL_APP_ROLES` beside mail,
    the calendar and the file manager. A configured command is filtered, not
    deleted: re-adding the role later finds it still there.

W2. **Two backends, one shape.** CUPS (`lpstat`/`lpq`, Linux + macOS) and the
    Windows spooler (PowerShell + `Get-Printer`/`Get-PrintJob`), mapped onto one
    closed set of state words so the pane renders identically on both. Every
    CUPS read runs under `LC_ALL=C` — those tools translate their output, and a
    German locale would blind every parser. A machine with no print system is a
    *state* (`supported: false` + a sentence), never an empty table.
    - [x] 🤖 Automated test — the `lpstat -l -p` / `-d` / `-a` / `-o` and `lpq -a`
      parsers, the Windows JSON shape (including `ConvertTo-Json` collapsing a
      one-element array into an object), and the name/id validation
      (`commands/printing.rs`, 11 cases)

W3. **Actions, and what they cost.** Make default (the *user's* default —
    `lpoptions -d`, never `lpadmin`, so nothing asks for a password), pause /
    resume a queue, print a test page, cancel one job, cancel a printer's queue.
    Pause/resume is the one that commonly needs rights the user does not have,
    so CUPS's own refusal ("Forbidden") is shown verbatim rather than replaced
    with a generic failure.
    - [ ] 🖐️ Manual test — with a real printer: pause/resume, cancel a job
      mid-print, make a second printer default, send a test page.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

W4. **What it deliberately does not do.** No print-this-file command exists on
    the whole surface — printing a document you are looking at is the viewers'
    job (`lib/viewers/print.ts` + the platform print dialog), so the manager
    never needs a path and therefore never offers one. No printer *setup*
    either: adding or configuring a queue is CUPS/Windows admin territory,
    needs elevation, and is a different program's job.

W5. **It reads only while on screen.** The queue poll is armed by the pane's
    `visible` flag, so a background print tab shells out to nothing, and a
    restored tab costs one `lpstat` — the same bargain the disk-usage, mail and
    browser tabs make about not replaying work on a launch path.
    - [x] 🤖 Automated test — `src/__tests__/Printing.test.ts` (state words
      degrade to "unknown" not "idle"; a job whose printer is gone still shows)

---
