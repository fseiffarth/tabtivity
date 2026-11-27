# Project boxes — design rationale

Why the box subsystem works the way it does; the *what* is in
`DOCUMENTATION.md` ("Project Boxes") and the code
(`src/stores/boxes.ts`, `src-tauri/src/commands/boxes.rs`).

## The overlay model (why members never fold into their box)

A box is a **temporary joining** of projects, not a container that owns them.
Two consequences drive the switcher's rendering:

- Member pills always render individually, wearing a small colour swatch per box. The
  earlier bucketing model (member pills hidden inside the box pill) made a
  box *cost* something — putting a project into a box removed its pill, so
  users had to choose between grouping and reachability. Overlaying keeps
  grouping free.
- Membership is N:M. A paper project can sit in a "thesis" box and a
  "collaboration" box at once; exclusive membership (the old per-project
  `box_id` back-reference) forced silent un-grouping whenever a second
  grouping was wanted. `member_ids` on each box is the only membership record;
  a stale persisted `box_id` is stripped in-memory on load and falls off disk
  with the next ordinary `save_projects`.

## The chip lists, the pills are the boxes

The leading segment carries the `BoxScopeChip` — root, the full boxes
list, "All projects", the editor doors — and, right of it, **one small pill per
box** (2026-09-22; up to `MAX_BOX_PILLS`, the rest stay in the list and the
chip counts them "+N"). Each box pill names its box in the box's colour, wears
the box's own status strip, is a standing drop target for "add this project to
that box", hosts rename and the box's context menu, and enters the box's scope
on one click.

Two earlier models preceded this. First the chip alone: it was both the menu
you open to go somewhere and the label saying where you are, so returning to
the box you were looking at meant opening a menu to click the row already
marked current. Then (2026-09-04) the *selected* box got a pill beside the chip
— but every other box stayed invisible until the list was open, so switching
between boxes was still a hover, a wait and a click each way, and adding a
project to a box that was not the selected one meant dragging into a sprung-open
menu. Boxes are few by nature (a handful of joinings, never a project list), so
a pill each costs the strip little, and the pills sit in the *fixed* segment
where the width argument that retired the original per-box pills (they stood
*among* the projects, in the scrolling strip) does not apply.

**Colour is the through-line.** `lib/theme/boxColor` hashes a stable hue from
the box's *id* (renaming never recolours), and every surface wears it: the box
pill's mark and active line, the swatch on each member's project pill (one
square per box — "which box" is read by eye, the tooltip only confirms), and
the rows of the chip's list and of a pill's Boxes menu.

**Adding members.** See "The 2026-11 redesign" below: one shared checklist,
quick create, and the slice in a store replaced the earlier Members list capped
before the editor.

## The 2026-11 redesign (why it looks the way it does)

The 2026-09 round made boxes visible; this round made them *easy to leave,
cheap to make and clear to work in*. Plan and per-step detail:
`docs/box_redesign_plan.md` (lens files `box_redesign_{access,membership,workspace}.md`,
commits in `box_redesign_handoff.md`). The user fixed four decisions, which the
rest follows from:

1. **Entering a box still hides non-members, but the way out is always
   drawn.** The selected pill carries a ✕ and the strip is tinted in the box
   colour; "All projects" in the list and the search's first row do the same.
   The rejected alternatives were dimming (a long strip stays long) and no
   slice at all (the 2026-09 round asked for boxed projects to be visible).
2. **Creating a box is "name it, Enter, you are in".** The old four-in-one form
   (name, members, a Box target dropdown that discarded the draft, two default
   names) is gone; membership is edited afterwards, where you are, by one
   checklist (`BoxMemberChecklist`) that closed projects can join too. Names are
   unique case-insensitively on *new* writes only (import joins by name and
   folders derive from names); legacy empties and duplicates still load.
3. **A new tab starts in the active tab's member.** The member is read from the
   tab's cwd (`memberOfCwd`), never stored: a stored field would go stale when
   a tab is renamed or its member leaves, and the old " — name" label suffix
   (which a rename erased) was the only trace before. "Start in…" picks another
   place. A remote member's root is its local copy (the mirror its box tabs
   run in, as the backend's box roots have it), never its `directory`, which
   is the project's state folder: rooting it there (until 2026-11-25) started
   "Shell/agent — ⟨member⟩" in the state folder, gave its tabs no chip and
   reset its restored agent tabs to the box folder.
4. **The side panel is one collapsible section per member**, rich headers; the
   collapse state is per-viewer `localStorage`, not a data file. First built as
   a strict accordion (one member open); on 2026-11-16 the user asked for
   several open at once, so a header click now toggles only that section.
   What survived from the accordion: with at most one section open the panel
   still *follows* the active tab (the one before folds), so a user who never
   opens a second one manages nothing. With several open nothing folds by
   itself; the tab's member opens beside them and is scrolled to. The one
   search field searches every open member, and each section answers for its
   own searchability (a remote member on its Remote side says it needs Local).

Consequences worth knowing before touching the code:

- **The slice lives in `stores/boxSlice.ts`**, not in `ProjectSwitcher`: the ✕,
  `cycleBox`'s return stop, the palette's "Show all projects", the search's "All
  projects", quick-create-then-enter and Dissolve-while-inside all clear or set
  it from outside. It is a *view*, not the scope, and session-only.
- **Colour has two shapes.** Boxes are swatches (`BoxSwatch`, the box's own
  `boxColor`), members are round dots (`memberColor(projectId)`); both draw
  from one hue space, so the shape — not the hue — says which is which.
- **Saves are diffs.** The box sheet sends `patch_box` with `name`, `addMembers`
  and `removeMembers`, never the member list, because a whole-list write erased
  a member added meanwhile. The frontend tolerates a backend that predates the
  fields (`unknown field` → singular calls), since `src/` hot-reloads and
  `src-tauri/` does not. The side panel's drag reorder is the same: a
  `patch_box` `order` names the members the panel shows and the backend puts
  them into the slots they hold, so a member it never saw (added by another
  window, or one with no folder) neither moves nor vanishes. `set_box_members`
  (the whole list) is only the fallback for a backend without `order`.
- **Taking access back is never gated.** The phone row of the box sheet needs
  tmux and persistent sessions to switch ON, and `set_box_mobile_access` checks
  neither when switching OFF; so a box whose access is already on keeps its
  switch when those preconditions fail, with a line saying it cannot work.
- **Discovery is part of the feature.** With no box, a dashed ghost pill stands
  where box pills would; Ctrl+K and the header search list boxes; a feature
  hint (≥ 4 projects, 0 boxes) points at the ghost pill. A box that is only
  reachable through a hidden control is a box nobody makes.
- **A box pill reports its members' agents too** (`BoxStatusBars`): a pill
  that read idle while a member worked would say nothing was running there.
- **Popout parity.** A popout seeds the box and its member projects once
  (`projectInfoForScope`), so its chip, "+" menu and title-bar mark (`▣ name` in
  the box colour) read that seed; a member added later shows no chip there
  until a reseed.

## Why silent dissolve died

`assignToBox` used to dissolve any box left with exactly one member — "a box
is meaningless with a single member". Under N:M and the overlay model that
reasoning inverted: a one-member (or empty) box is a *staging area* the user
is still filling, and tearing it down as a side effect of removing one member
destroyed work (the box's name, position, folder association) nobody asked to
lose. Dissolving is now exclusively an explicit, confirmed **Dissolve box…**; the confirm states what survives (folder + agent docs on disk, every
member untouched). Empty boxes render dimmed rather than vanishing.

## The box tab scope (`box:<id>`)

A first-class persisted scope, disjoint from project ids and `"root"`:

- **Persist**: `CenterPanel` persists the *active scope*; a box scope goes to
  `<state_dir>/sessions/box_<id>/terminals.json` with an empty `localFile`, so
  the project-tree export copy is skipped (the root-scope pattern — there is
  no `project.json` for a box, and the box folder must never become a source
  of executable intent).
- **Restore**: lazy, on first entry per session (`restoreBoxScope` in
  `stores/boxes.ts`); nothing restorable seeds one shell at the box folder.
  The seed lives in the restore path, NOT in `openBox`, so restore and seed
  cannot race — `openBox` only ensures the folder and switches the scope.
- **Leaving**: `activeId` doesn't change when a box opens, so the scope-setting
  effect keys on `switchGeneration` too — clicking the already-active
  project's pill is the gesture that must exit the box.
- **Spawn/read authority**: the PTY gate (`pty_spawn`) and the absolute-path
  confinement (`compute_allowed_roots`) both accept the box folder ∪ member
  roots ∪ remote members' mirrors and fail closed on an unknown box. A remote
  member's `directory` is no spawn/fence root (2026-11-25): it is its state
  folder, or a legacy entry's whole home, and every box agent is handed each
  root (fence bind, Claude `--add-dir`). A box tab saved there restores into
  the member's local copy (`remoteMemberCwdMoves`). A tab may
  be rooted in a member root — deliberately, since Claude keys its resume
  history by cwd, so a member-rooted agent tab resumes that member's
  conversations.
- **Trust (v1)**: box tabs run local + uncontained. A member's container/VM
  boundary is a per-project promise; silently extending one member's sandbox
  to a scope that can also reach the other members' trees would look like a
  boundary without being one. `enforce_spawn_authority` pins `sandbox: false`
  for box scopes, and the box sheet shows a one-line notice when a member is
  containerized/VM.

## The symlink farm and its manifest

The box folder carries one symlink per member (`./<member>/`, Unix only) so
agent CLIs launched there can traverse into every member's tree — that is the
whole reason the box folder is a useful agent cwd. Ownership is the subtle
part: `.tabtivity-box-links.json` records exactly which names Tabtivity created, so
regeneration removes only manifest-owned entries that are *still symlinks* and
whose member vanished or moved. A user file shadowing a member's natural name
is never replaced — the member re-links under a `-1`/`-2` suffix. Dangling
targets are still linked (a member's folder may not exist yet). Tabtivity's own
confinement deliberately does not follow the links; the multi-root Files view
is Tabtivity's file surface, and the allowed-roots sets are explicit.

## What the 2026-11-16 review hardened

Two reviewers read the feature end to end; what changed, and why it must stay:

- **The link manifest is untrusted input.** It sits in a folder every member's
  fenced agent can write, and the refresh runs unfenced. Only keys that are one
  plain file name count (`is_link_name`); it records only links that were
  really made; names are compared case-folded on Windows and macOS.
- **Names and paths are one escaped line of the generated agent docs**
  (`doc_text`/`doc_name`): those docs are instructions to every agent started
  in the box folder, and an imported bundle names its own project.
- **Every box writer edits under the file's lock** (`box_store::update_boxes`).
  Box commands run concurrently (browser clients on the blocking pool, the
  Mobile sidecar, an async import); a read taken before the lock lost updates.
- **`folder` is an authority root, written only by `ensure_box_folder`.** The
  whole-list `save_boxes` keeps the file's folder, and the root builders drop a
  folder that is empty or relative (`box_folder_root`).
- **Inside a box `activeId` is not "the project on screen".** It stays on the
  project the box was entered from. The side panel, tab jumps, the steering
  ring and the header search each compare against the tabs scope instead.
- **Dissolving closes the box's own tabs** (`pty_kill_scope` + `unloadScope`,
  as closing a project does), after the delete succeeded.
- **One file watch per folder** (`fs_watch.rs`), since a box mounts several
  trees at once.

## The user's decisions of 2026-11-16

Asked one at a time after the review; each reverses or completes something
above, so the earlier text is read with these:

1. **Dissolve deletes the box's state**, as removing a project does: the saved
   tab layout, both agent homes (with the copied logins), resume records,
   checkpoints and scheduled prompts of `box:<id>` (`forget_box_state`). The
   record goes first, then the scope's terminals, then the state. The box
   folder and the members stay. "What survives" in the confirm still holds for
   the folder; a line says what goes.
2. **The header "+" keeps every project action inside a box**, with the shared
   member checklist as a group on top. The old members-only menu left New
   project and Import unreachable until the box was left.
3. **The box menu has a visible door**: a ⋯ on the selected pill and on every
   row of the boxes list. "Edit boxes…" (which opened whichever box came first)
   is gone; a box with no pill renames in its sheet.
4. **✕ on a member is undoable**: a toast offers Undo and puts the project back
   at its place in the box's order.
5. **A box has one order.** The pill strip inside a slice follows `member_ids`
   like the side panel's sections, and a pill drag reorders the box, not the
   general strip. A non-member in scope comes last.
6. **The box sheet has no Save.** A tick, a colour pick and the name (Enter or
   blur) apply at once, as its phone row and the pill menu's checklist always
   did. Mixed commit models lost unsaved ticks to a click outside.
7. **A closed member the box reopened can be stopped, and is on leaving.** The
   pill menu has Close project inside a box; leaving the box stops the tabs of
   members that are closed in the general strip (`stopClosedProjectScope`,
   layout saved first, the project stays closed), since they have no pill
   there. The one on screen and members of the next box are left alone.
8. **The box folder presents members as a box tab can reach them.** A remote
   member is linked and listed by its local copy; a host-only or
   Local-models-only member is named as not reachable, never linked
   (`member_projects_in`, the same rules as the box's roots).

## What stays out of scope (v1)

- A disconnected remote member's section in the box file view shows a connect
  prompt; a mirror fallback is a follow-on.
- No box-level sandbox or VM.
- Box tabs are local-only (`closeRemoteTab`'s remote-session classification
  resolves no project for a box scope); local shells DO get tmux persistence,
  since the scope restores and a surviving session has a tab to reattach to.
