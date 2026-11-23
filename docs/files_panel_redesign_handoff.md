# Files tab and side panel redesign — handoff

Plan: `docs/files_panel_redesign_plan.md`. Canvas:
<https://claude.ai/artifact/PGiR6Qnxd1jq2grD47ma8x>. Built 2026-11-22 by three
implementers in parallel worktrees, merged and reviewed by the main agent.
**Never run live.**

## Commits on develop

| Step | Commits | What |
| --- | --- | --- |
| Kit | `714a4f528` | `src/styles/side-panel-kit.css`, the plan |
| A | `c3aedbe04`, `c291344a4` | Panel header and view strip, Files view (row grid, chips, one toolbar row, wide column list), Downloads one-line form |
| C | `088822732`, `a20831f46`, `511571d1d`, `669c6575e`, `ef3356e94` | Agents + CLIs, Archive, Remarks, To-do heads, Tabby head row |
| Review | `bf65b1446` | Fix: a passive sync mark no longer takes the row's action slot from Run |
| B | `5b9b0e686`, `2d496f4d9`, `7de6736f8`, `979836857`, `62d2af95b` | Git, Diverged, Sessions, Jobs, Apps |
| Merge | the commit carrying this file | File map rows, untested row text, dead CSS and one unused string removed |

B's commits needed one conflict resolved three times, always the icon import line of
`ProjectFilesView.tsx` (A added `ArrowUpRightIcon` to it); both sides' icons kept.

## What changed, per view

- **Chrome.** Header row, view strip, at most one toolbar row per view. Below 560 px
  only the active view keeps its label. Project settings is the header row's gear (the
  docked viewer, which has no header row, ends its strip with it). With an SSH tag on
  the header the Git tag is dropped and the provider tag shortens to its name.
- **Files.** Every row reserves the git chip cell and one action slot, so folder and
  file icons share a line. Git state is a letter chip (U, M, S, P), never red. Sizes
  are neutral with a share bar. Section heads are quiet. One toolbar row (breadcrumb,
  total, sort, then search, refresh, import, open in file manager, downloads). From
  720 px a sticky, sortable column header: Name, Git, Modified, Size, Share of folder.
- **Downloads.** One line while its window holds no rows.
- **Git.** Change lists inline as folding groups (Not staged, Staged, Outgoing) with a
  stage box per file; branch and upstream counts in the toolbar; footer with one
  primary action. The commit flow is unchanged.
- **Diverged.** Three groups with bulk actions in their heads; rows with a chip and a
  second line (state word, both modification times).
- **Sessions.** Machine head with the bulk kills; sub-heads with counts; rows with a
  status word. Names unchanged.
- **Jobs.** Queue first with squeue-code chips and elapsed time, then workspaces; Pull
  logs in the toolbar.
- **Apps.** On a parking desktop: "Hidden when you switch projects" and "Stays on
  screen when you switch projects", the Wayland sentence once; different icons for
  Close app and Remove from list.
- **Agents.** Rows collapsed to name, CLI · model · time and a status word; a chevron
  opens the details and every action.
- **CLIs, Archive, Remarks, To-do, Tabby.** On the kit; Remarks gets a `+` per file and
  an always-present Open REMARKS.md; Archive rows show a kind icon and word.

## Choices made along the way

- **Staged is `--info`, chips are neutral** with the colour on the letter: the accent
  budget and the chip rule in `docs/context/desktop_ui_system.md` outrank the canvas.
- **Git is a sortable column** (A): `TreeSortKey = SortKey | "git"`, order untracked,
  modified, staged, unpushed, clean, ignored; the narrow dropdown offers it too.
- **Action slot order** (A, corrected in review): sync button, Run or the compile
  spinner, sync mark (excluded, folder diverged), remark count, auto-sync indicator.
  A file that still has to be pushed shows the sync button instead of Run; Run stays
  in the context menu.
- **Names ellipsize** in the tree instead of wrapping (A); the hover tooltip has the
  full name.
- **Git groups** (B): a group of more than 40 files opens with its folders folded; a
  folded group reads nothing. The lists re-read when the git status changes
  (`git_change_stats`, up to three reads), where the popovers read on click only.
- **Agents** (C): a schedule an agent proposed stays visible under a collapsed row,
  since it waits on approval.
- **CLIs** (C): fixed a poll that restarted on every render and called
  `agent_overview` back to back while the view was shown.
- **New strings** are in all five dictionaries (`i18n.test.ts` requires it); the
  de/es/fr/it wording is the implementers'.

## Flagged for the user

1. **Files actions moved.** Import, Open in file manager and the Downloads toggle are
   in the Files view's toolbar only. They used to show in every view.
2. **Agents needs one more click** for every action but jumping to the tab.
3. **Git read cost.** The inline groups read on each git status change. Fold a group
   to stop its reads.
4. **Translations** of the new strings (de, es, fr, it) were written by the agents.
5. **Not built, by decision:** the Git "Commit acts on the open draft" flow, the
   mirror-skips notice in Diverged, Sessions named after tabs, the To-do
   Works/Doesn't-work switch.
6. **Not drawn or checked:** container-query layouts (jsdom runs none), every theme
   other than by tokens, WebKitGTK rendering.

## Gates

`scripts/gates.sh --base d64af9b33` on the merged tree, 2026-11-22: brand, whitespace,
lint, build and vitest (`--changed` against the base) all pass. Rust gates do not
apply (no Rust change). One implementer run saw `tex/BibCards.test.tsx` time out
under load; it passes alone and passed in the merged run.

## Click-through (nobody has run it)

1. **Files, side panel.** A git project with a subfolder, a script and a remark: all
   icons on one line; U/M/S/P chips; grey sizes with a small bar; quiet section heads
   that fold; one row with breadcrumb, total, sort and the five actions.
2. **Files tab, wide.** Open a Files (Project) tab wider than 720 px: column header
   appears, the sort dropdown goes. Click Size twice, then Git, then Modified.
3. **Narrow panel.** Drag the panel narrow: only the active view keeps its label.
4. **Downloads.** Toggle it on with nothing recent: one line. Change the window, open
   it with the chevron, fold it.
5. **Remote project.** Header shows no Git tag and a short provider tag. In an
   auto-synced project a script that is in sync still shows Run.
6. **Git.** Edit a tracked file, add a new one, stage a third: groups show M, U, S;
   ticking a box moves a file; Commit → generate → Confirm still commits; after that
   "Outgoing" lists it and Push is the primary button. Toggle Graph.
7. **Diverged, Sessions, Jobs** (remote / HPC project): groups, chips, second lines;
   every destructive action still asks first.
8. **Apps.** GNOME Wayland: two sections, one sentence. X11: one section. A desktop
   that parks nothing: the single list and its note.
9. **Agents.** Chevron opens a row; Go to, Prompt, Continue, Schedules, Rename work;
   drag to reorder under Tab order.
10. **CLIs, Archive (panel and the + menu's dialog), Remarks, To-do (dev build),
    Tabby.** As listed per view above.
