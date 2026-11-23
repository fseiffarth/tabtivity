# iPad chat in three columns — plan

Status: steps 1 and 2 code-complete, never seen on an iPad (2026-11-23). Handoff: `docs/ipad_chat_columns_handoff.md`.

## Why

On a landscape iPad (about 1180 × 820) the agent Chat view is a fixed 660 px
column (`mobile-web/src/style.css`, "The Chat view" in the `Tablet tiers`
block), so about 260 px on each side stays empty. Meanwhile the session's
subagents, files, sent files and queue sit behind chips and header pills that
open over the chat, and switching to another tab of the project means going
back to the project screen. The user picked a three-column layout ("B") from a
design canvas: the project's tabs on the left, the chat in the middle, a
session overview on the right.

## Fixed decisions

Reviewers and implementers may not undo these; raise a doubt under "Flagged
for user" in the handoff instead.

1. **Tiers.** The three columns exist only in the `split` tier
   (`SPLIT_QUERY`, `mobile-web/src/useTier.ts`). A portrait tablet (`tablet`
   tier) gets a strip of tab chips under the header and nothing else new. A
   phone, and a phone on its side, change in nothing.
2. **No new backend, no new polling loop.** The rail reads the project's
   `TabRow[]` from `getProjectDetail` (`mobile-web/src/api.ts`), which
   `Terminal` already calls on opening and on `visibilitychange`. Keeping the
   other tabs' states current reuses whatever `screens/Project.tsx` uses to
   keep its cards current, at that screen's cadence, only while the rail or
   strip is on screen and the page is visible.
3. **Switching tabs** calls the `openTab(next)` prop `Terminal` already has
   (`App.tsx` re-keys the screen by tab id). No new navigation state.
4. **The screen's tree does not branch on the tier** (the comment over
   `useTier()` in `Terminal.tsx`): rail, strip and overview are siblings added
   beside the existing body; the terminal host, the socket, the draft and the
   scroll must survive a turn of the iPad. `MobileTabletChat.test.tsx` checks
   this today and must keep passing in spirit.
5. **Header spans the full width; rail and overview start below it.** The
   phone-landscape block is the precedent for making `.terminal-screen` a
   grid with columns.
6. **Looks come from what is there.** Surfaces use the tablet tier's own
   tokens (`#1a1d2b` panel on `#0b0d13`, `var(--soft)`, `--r-panel`,
   `--r-card`, `--hit`); every colour is an authored hex like its neighbours
   so `themeColors.ts` recolours it. Status marks, the "asking" pill, the tab
   colour stripe and the PLAN/GOAL ring come from the components `TabCard`
   uses (`AgentStatusPill`, `AgentModeMarks`), not from new markup. No
   animated blurred shadow; no new opacity loop.
7. **Untested pills.** Step 1 registers `mobile.chatRail`, step 2
   `mobile.chatOverview` in `src/lib/untested.ts`, each with one
   `UntestedTag`-style pill on its surface (the phone app's `.untested` span,
   as `mobile.tablet` does it).
8. **Strings** go through i18n with English and German entries
   (`src/lib/i18n/en.ts`, `de.ts`); keys under `mobile.chatRail.*` and
   `mobile.chatOverview.*`. Reuse existing keys where the wording is the same
   (`mobile.project.subagentsRow`, `mobile.project.filesRow`,
   `mobile.queue.title`, `mobile.subagent.running`, …).
9. **Out of scope (v1):** a "New tab" button in the rail, drag-reordering in
   the rail, closing or renaming a tab from the rail, keyboard-steering
   regions for the rail and the overview (their rows are plain buttons, so Tab
   reaches them), any change to the Terminal view's own layout, Tabby's chat
   (`bare`), and tabs without a project.

## The layout (split tier, 1180 px wide as the reference)

| Column | Width | Content |
|---|---|---|
| Rail | 208 px panel + 12 px left margin; folded: 64 px | The project's tabs |
| Chat | the rest; text measure capped at 700 px, centred; at least 24 px side padding | Transcript, facts row, composer, as today |
| Overview | 308 px panel + 12 px right margin; 400 px with the library open (today's dock width); 480 px with a file open | Session lists, or the library, or a file |

Both panels are floating rounded surfaces (`--r-panel`, `var(--soft)`) with
12 px to the window's edge and bottom, like Home's list in `.tabbed.split`.

- Under 1120 px of window width the rail is always folded.
- Whenever the overview is wider than 308 px (library or file open) the rail
  folds by itself and unfolds again afterwards; the stored preference is not
  written by that.
- With the overview closed the chat is centred in the space beside the rail.

## Step 1 — the tabs rail and the portrait strip

New: `mobile-web/src/components/ChatTabsRail.tsx` (rail and strip, one
component with a `variant`), pure helpers beside it if needed
(`mobile-web/src/chatRail.ts`), flag `chatRailFolded` in
`mobile-web/src/prefs.ts`.

- **Shown** for a tab inside a project (`project` set, not `bare`) when the
  project has at least two tabs. With one tab there is no rail and no strip.
- **Order** is `detail.tabs`' order (the desktop's).
- **Row (unfolded):** status mark, the tab's label on up to two lines, and a
  second line: for an agent its model (`agent_model`, else `agent_label`) and
  its state in the words `TabCard` uses; for a shell the existing shell
  label. A tab in `question` state carries the existing asking pill. The
  current tab is marked (`aria-current="true"`, the selected background the
  split list's `.is-current` uses). A tab with `available === false` is
  dimmed and not tappable. The tab's colour shows as the existing stripe.
- **Row (folded):** a 48 × 48 tile: the first letter of an agent tab's label,
  a prompt glyph for a shell; the status mark as a corner dot; `question`
  state tints the whole tile like the asking pill. `aria-label` carries the
  label and the state.
- **Head:** "Tabs · n" and a fold button (`aria-pressed`); folded, the same
  button unfolds. The preference is `chatRailFolded`.
- **Tap** on another tab: `openTab(row)`. Tap on the current one: nothing.
- **Portrait strip** (`tablet` tier, not split): one row of chips under the
  header, horizontally scrollable, the current chip scrolled into view on
  mount; chip = status mark + label (one line, ellipsis at 22 ch) + asking
  pill. Same rules for when it shows.
- **Layout:** `.terminal-screen` gains a rail column in the split tier
  (attribute `data-rail="open" | "folded"` on `main`), header across all
  columns. The Terminal and Diffs views keep the rail (it is navigation).
- **A prop for step 2:** the rail takes `forceFolded?: boolean`.
- **Chat measure:** raise the Chat view's cap from 660 to 700 px and its
  minimum side padding to 24 px, in the split tier only; the portrait tablet
  keeps 660.
- **Tests:** `src/__tests__/mobile/MobileChatRail.test.tsx` — shows from two
  tabs, order, current mark, `openTab` on tap, dimmed unavailable row, fold
  flag round trip, strip in portrait, nothing on a phone; a stylesheet test in
  the style of "the tablet chat stylesheet" in `MobileTabletChat.test.tsx`.
  Update that file's 660 px assertion to the new split/portrait pair.
- **Docs:** rows in `docs/filemap_frontend.md` (the new component; the
  `useTier.ts` row's mention of the chat), the `mobile.chatRail` register
  row, a manual-QA entry in the matching `todo/<group>.md` with the four
  platform child pairs replaced by what applies to a phone app (follow the
  neighbouring iPad entries).

## Step 2 — the session overview

New: `mobile-web/src/components/ChatOverview.tsx`, flag `chatOverviewPane`
in `prefs.ts` (default on: `readFlag("chatOverviewPane", true)`).

- **Where:** split tier, a tab inside a project. One header button (a panel
  glyph, `aria-pressed`) opens and closes it; it replaces the folder button
  there. Closed while something runs, the button carries the number of
  running subagents.
- **Agent tab:** three modes in the one pane.
  1. *Overview* (default): stacked sections, each drawn only when it has
     something:
     - **Running / Subagents** — `sessionAgents` through `splitByWork`, the
       running group first, then finished (finished capped at three with a
       "Show all" that expands in place); a row opens it as the chat index
       does (`openListedSubagent`). Reuse the `.subagent-index-list` row
       markup and status marks.
     - **Queue** — only with queued prompts: the count and a row that opens
       the existing queue sheet.
     - **Files** — `chatFiles` (what `SentFilesIndex` lists), newest four
       with "Show all (n)" expanding in place; a row opens the file
       (`openChatFile`), a hold opens the existing file menu. The section's
       head has "Project files", which switches the pane to the library.
     - **Sent** — `tabOutbox`: the newest three as tiles (the gallery's own
       tile component) and "Show all", which opens the existing
       `OutboxGallery`.
     - **Links** — `chatLinks`, as `ChatLinksIndex` lists them, newest four.
     With no section at all the pane says so in one muted line and keeps the
     "Project files" entry.
  2. *Library:* today's docked `ProjectFiles` (`docked`), unchanged inside,
     with a "‹ Overview" way back.
  3. *File:* a file opened from the chat, the overview or a transcript link
     opens `OutboxViewer` with `paned` inside the pane (the library's
     `files-split` is the precedent) instead of over the chat. Mark up still
     takes the whole screen, as it does from the library. "‹ Overview"
     returns. This is its own commit (2b); if it cannot be made clean, stop
     at 2a green and flag it.
- **Shell tab:** the pane is the library only (today's behaviour behind the
  new button).
- **While the pane is open** the transcript's `.chat-index` chips are not
  drawn (the pane shows the same lists); closed, they come back.
- **Header in the split tier:** the queue pill and the sent-files pill are
  gone (their content is in the pane); model pill, Chat | Terminal and the
  pane button stay. Portrait tablet and phone keep today's header.
- **Rail:** pass `forceFolded` while the pane is in library or file mode.
- **Turning the iPad:** as `chatFilesPane` behaves today — the pane returns
  in landscape as this device left it, and leaves in portrait unless a file
  or a markup view hangs on it. `chatFilesPane` itself is retired; read it
  once as the fallback for `chatOverviewPane` so nobody's pane flips.
- **Tests:** `src/__tests__/mobile/MobileChatOverview.test.tsx` — default
  open in landscape, sections only when non-empty, chips hidden while open,
  header pills gone in split and present in portrait, library mode and back,
  file opens paned and the rail folds, shell tab is library only, the socket
  and draft survive a tier change. Update the affected cases in
  `MobileTabletChat.test.tsx` and `MobileTabletSplit.test.tsx` deliberately,
  never by deleting an assertion that still describes wanted behaviour.
- **Docs:** filemap rows, register row `mobile.chatOverview`, manual-QA
  entry, and one paragraph in the `docs/context/` file that describes the
  phone app's tablet chat (grep `Tablet tiers` / `useTier`; add to
  `mobile_access.md` if none does).

## Organisation

Two implementers (Opus), **serial, each in its own worktree**: step 2 starts
from step 1's commit. Serial because both steps edit the same `<main>` line
and header of `Terminal.tsx`, the `Tablet tiers` block of `style.css`, the
i18n dictionaries, `untested.ts`, the filemap and the same test files. No
plan-review or reviewer agents (the user asked for two); the main agent
reviews each range and lands it.

| Agent step | Plan section | Main files |
|---|---|---|
| 1 | Step 1 | `ChatTabsRail.tsx` (new), `Terminal.tsx`, `style.css`, `prefs.ts`, tests |
| 2 | Step 2 | `ChatOverview.tsx` (new), `Terminal.tsx`, `style.css`, `prefs.ts`, tests |

## Verification

Per step: `scripts/gates-job.sh start`, then its `status` until the exit code
is there; all touched gates green at zero new warnings. Never start the app.
The handoff lists click-through steps for the user (iPad landscape, portrait,
a phone as the regression check).
