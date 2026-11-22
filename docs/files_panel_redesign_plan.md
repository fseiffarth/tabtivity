# Files tab and side panel redesign — plan

Status: in progress (2026-11-22). Design canvas:
<https://claude.ai/artifact/PGiR6Qnxd1jq2grD47ma8x> (thirteen artboards: the wide
Files tab and all twelve side panel views). Handoff: `docs/files_panel_redesign_handoff.md`.

## Why

The Files tab is the side panel's file view stretched across a wide pane, and the
panel's twelve views each grew their own rows, heads and action rows. What the
user's screenshot showed:

1. Files look nested under a sibling folder: the remark slot is reserved on file
   rows only (`FileTree.tsx`, `remarkCount … !e.is_dir`), so file icons sit one slot
   right of folder icons.
2. In a wide tab, name and size are a pane-width apart, and the dates the tree
   already sorts by are never shown.
3. Red is overloaded: a red dot for ordinary git state, red text for a big file.
4. Three thin chrome rows of unlabelled glyphs sit above the first file.
5. An empty Downloads section takes about 190 px.
6. Section heads are heavier than their content.

## Fixed decisions

Reviewers and implementers do not reopen these.

- **Scope (user, 2026-11-22):** restyle all twelve views and the wide Files tab, plus
  the structural proposals that only move or group things. **Out:** the Git "Commit
  acts on the open draft" flow change, moving the mirror-skips notice to Diverged,
  Sessions showing tab names, the To-do Works/Doesn't-work switch.
- **Wide layout (user):** from a container width of 720 px the Files view is a column
  list — Name, Git, Modified, Size, share bar — with a sticky header whose cells are
  the sort control. Below that, compact rows. One shared view, switched by a
  container query; viewer features stay in `ProjectFilesView` (AGENTS.md).
- **Sizes (user):** neutral text plus a share bar (the entry's share of its section
  total). The `size-small/medium/large/huge` heat colours go.
- **Downloads (user):** one line when empty; the full resizable section when it has
  rows or is opened.
- **One row grid:** every list row is `.sp-row` (state · action · icon + name ·
  meta) or, for the file tree, `.file-entry` given the same fixed columns. Columns 1
  and 2 are reserved on every row of a list. This is the fix for finding 1.
- **Git state is a letter chip** (`.sp-chip`): `U` untracked, `M` modified, `S`
  staged, `P` committed-not-pushed; the word is the `title`. Ignored: no chip, muted
  name. The colours stay one map (`lib/theme/gitColors.ts`) and change there:
  untracked `--text-secondary`, modified `--warning`, staged `--info`, unpushed
  `--success`. (The canvas drew staged in the accent; the accent budget in
  `docs/context/desktop_ui_system.md` reserves the accent, so it is `--info`.)
- **Red** (`--danger`) only for errors and destructive actions.
- **Chrome:** header row, view strip, then at most one `.sp-toolbar` row per view. At
  a narrow container the strip shows icons only, the active view icon + label
  (today's container query at 560 px already drops the labels; the active one keeps
  its label). Primary actions sit in the view's `.sp-foot` or its toolbar, not both.
- **Section heads** are `.sp-head`: sentence case, no rule, 8 px of air.
- **Remote header:** with a host tag present, the Git tag is dropped and the
  provider tag shortens to its name, so the project name never truncates first.
- **Tokens only.** No hex in CSS or TSX; sizes from `--text-*`, space from
  `--space-*`. The canvas's hexes are the light lavender theme's values of those
  tokens. Every theme must work.
- **Existing classes before new ones** (`.btn-primary`, `.settings-btn`,
  `.btn-quiet`, `.seg`, `.toolbar-btn`, `.file-doc-badge`, `ErrorNote`,
  `SkeletonRows`). New shared rules go in `src/styles/side-panel-kit.css`, nowhere
  else; a view's own rules stay in the file they are in today.
- **Glyphs** come from `common/icons/Icon.tsx` (`GLYPH_SYNTAX` lint); the `▾ ▸ ± ⊘`
  text glyphs in the touched markup become icons.
- **No behaviour change** beyond what a step names: selection, drag, steering
  (`data-entry-path`, `data-steer-*`), context menus, keyboard, remote gating
  (probes gated on connected), `PaneVisibleContext` gating all stay.
- **Strings** through `useT()`; new keys in `src/lib/i18n/en.ts` beside the view's
  existing keys.
- **Untested pills:** the new column list wears `UntestedTag` id
  `fileTree.columns`; no other pill is added (a restyle is not a new feature).
  The row is added at merge, not by the implementers.

## Shared kit (landed first, by the main agent)

`src/styles/side-panel-kit.css`: `.sp-toolbar` (+ `-title`, `-meta`, `-end`),
`.sp-row` (+ `--plain`, `--two`, `.selected`; cells `.sp-row-state`, `.sp-row-act`,
`.sp-row-main`, `.sp-row-text`, `.sp-row-name`, `.sp-row-sub`, `.sp-row-meta`),
`.sp-chip`, `.sp-status` (+ `--running`, `--waiting`, `--failed`), `.sp-head` (+
`-meta`, `-end`), `.sp-count`, `.sp-bar`, `.sp-note`, `.sp-foot`. An implementer who
needs a shared part that is missing adds it there and says so in the handoff.

## Agent steps

| Step | Views | Files it owns |
| --- | --- | --- |
| A | Panel chrome (header, view strip, Files toolbar); Files view narrow and wide; Downloads | `ProjectFilesView.tsx` **above** the `view === "git"` block; `FileTree.tsx`, `useFileTree*.ts`, `ProjectFilesPane.tsx`, `DownloadsSection.tsx`, `ProjectFilesTab.tsx`; `file-tree.css`; the header/toolbar rules of `files-panel.css`; `lib/theme/gitColors.ts` |
| B | Git, Diverged, Sessions, Jobs, Apps | `ProjectFilesView.tsx` **from** the `view === "git"` block down (git, orange, sessions, jobs, windows); `GitChangeTree.tsx`, `GitHistory.tsx`, `GitPullPanel.tsx`, `SyncHostOnlyFiles.tsx`, `SyncMirrorSkips.tsx`; their rules in `files-panel.css` |
| C | Agents, CLIs, Archive, Remarks, To-do, Tabby | `agents/AgentSchedulesView.tsx`, `agents/CliOverviewView.tsx`, `tabs/TabArchiveList.tsx`, `files/RemarksPane.tsx`, `files/DevTodoView.tsx`, `assistant/AssistantView` (its own header row only: the transcript and composer are the shared Reader and stay); their CSS |

### A — chrome and Files

1. `gitColors.ts`: the new map (above). `GitMarker` renders `.sp-chip` with the letter.
2. `.file-entry` becomes the fixed-column grid: chip, one action slot (run / sync /
   compile spinner / remark count share it by priority: sync action, run, remark
   count), icon + name + badges, size + `.sp-bar`. Folders and files reserve the same
   slots. Size heat classes removed.
3. Section heads (Project docs, Agent memory, Gitignored, hidden extensions) become
   `.sp-head`; their totals move to `.sp-head-end`.
4. One toolbar row: breadcrumb (up, home, crumbs), folder total, then search, refresh,
   import, open in file manager, downloads toggle. Compact sort control stays in the
   narrow layout.
5. Wide layout (container ≥ 720 px): sticky column header (Name, Git, Modified, Size,
   Share of folder) whose cells sort (click sorts, click again reverses, `aria-sort`);
   Git column shows the state word, Modified shows `modified_secs` formatted like the
   tree's existing date formatting; the narrow sort control hides. The Files tab's
   list sits on `--bg-main`, its chrome on `--bg-panel`.
6. Downloads: collapsed one-line form when the window holds no rows (label, "None in
   the last hour"-style text per window, the `.seg` window picker, refresh); the
   existing full section otherwise.
7. View strip and header per the fixed decisions; remote header tag rule.

### B — Git, Diverged, Sessions, Jobs, Apps

1. **Git:** branch + upstream line in the `.sp-toolbar`; the change trees shown inline
   as `.sp-head` groups (Not staged, Staged, Outgoing) above the history instead of
   footer popovers, each file an `.sp-row` with chip and its existing stage toggle;
   the footer (`.git-action-bar`) keeps Add / Commit / Push / Pull / Release with one
   primary, and the commit flow stays exactly as it is (generate → confirm). History
   rows on the row grid.
2. **Diverged:** the three groups as `.sp-head` with their bulk actions in the head;
   rows two-line `.sp-row` with a chip and the existing per-row actions. The
   mirror-skips notice stays where it is.
3. **Sessions:** host group head with the bulk kills (`.btn-quiet.is-danger`);
   Agents / Shells / Other sub-heads with `.sp-count`; rows two-line with
   `.sp-status`. Names stay as they are.
4. **Jobs:** Queue section first, then Workspaces; "Pull logs" in the toolbar; job
   rows with a state chip (`R`, `PD`) and elapsed time; workspace rows with the
   existing expiry tone.
5. **Apps:** two sections — hidden on project switch, stays on screen (the
   `rowStaysVisible` split) — with the Wayland sentence once under the second head;
   "Close app" and "Remove from list" get different icons. When the desktop parks
   nothing, today's single list and note stay.

### C — Agents, CLIs, Archive, Remarks, To-do, Tabby

1. **Agents:** toolbar (title, count, sort, prompt chart); rows collapsed to name,
   CLI · model · time, and `.sp-status` with the real words (Working, Needs a
   decision, Finished, Idle); a chevron opens the row's details and actions. The open
   state is per row and local.
2. **CLIs:** toolbar with Refresh; each CLI a two-line `.sp-row--plain`; usage meters
   under it on `.sp-bar` metrics, without the ≥ 90 % colour.
3. **Archive:** filter + bulk delete in the toolbar; rows two-line with a kind icon
   and the kind word; delete as an icon button.
4. **Remarks:** walker and counts in the toolbar, "Open REMARKS.md" always there; one
   `.sp-head` per file with a `+` that opens `AddRemarkDialog` for that file; rows
   with the done checkbox in column 1 and go-to in column 2.
5. **To-do:** group heads as `.sp-head` with "N open · N done"; the body's markdown
   rendering and write-back unchanged.
6. **Tabby:** its header controls in an `.sp-toolbar`; nothing else.

## Organisation

Disjoint subsystems once the contract is fixed: the main agent lands the kit and this
plan, then **three implementers in parallel** (user's bound: three Opus subagents),
each in its own worktree reset to `develop`. `ProjectFilesView.tsx` is split by
region between A and B; the main agent cherry-picks A, then B, then C onto `develop`
and resolves what overlaps. The plan review and the final review are the main
agent's, since the bound leaves no reviewer agent.

Hot shared files: `src/lib/i18n/en.ts` (each implementer adds keys only beside its
own views' keys), `src/lib/untested.ts`, `docs/filemap_frontend.md` (not edited by
implementers: listed in the handoff, applied at merge).

## Verification

Per step: `scripts/gates.sh` (build, test, lint, brand-check for a frontend change),
tests updated with the markup they assert and added for new behaviour (column sort,
Downloads collapse, the Apps split, the Agents expand). Never run live: the handoff
ends with click-through steps for the user.
