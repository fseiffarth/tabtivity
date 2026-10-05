# Git worktrees (#23) — audit and improvement plan

> **Status (2026-07-28): Phases 0, 1 and 2 are implemented on `develop`; phases 3
> and 4 are not.** Everything below is kept as the audit that produced them —
> the findings are the record of *why* each piece is shaped the way it is, not a
> backlog. See the “What shipped” section at the end for the per-finding outcome,
> including the two places the implementation deliberately deviates from what is
> written here. None of it has been live-verified in the running app.

Audited on `develop` at v0.1.43. Two independent passes: the backend command
surface (`commands/git.rs` + every subsystem a worktree touches) and the
frontend/UX + product integration. Every git behaviour claim below was verified
empirically against **git 2.53.0** in a scratch repo — real `worktree list
--porcelain` output, real exit codes — not inferred from documentation.

Related: `todo/group-e-worktree.md` #23, `docs/context/git_sync.md`,
`docs/sandbox_hardening_plan.md`, `docs/context/docker_containers.md`.

---

## Verdict

**The backend is a competent, safe wrapper around four git verbs. The frontend
is a stub that was never finished, never styled and never exercised end to end.
And neither side knows the rest of Tabtivity exists.**

The feature is currently a strictly worse `git worktree add`: fewer options than
the CLI, no shell completion, and it hands back a pill you cannot click. That
gap is the whole finding — not the individual bugs.

### What is genuinely solid

- **Threading is right.** All four commands are `async` wrappers over
  `*_blocking` bodies offloaded through `run_off_thread` (`git.rs:187-193`;
  call sites `:1411, :1438, :1483, :1509`). The known "sync git command over SSH
  freezes the window" bug class does not apply.
- **Option injection on the two `worktree add` positionals is closed.** `git
  worktree add` has no `--` boundary and both positionals are gated —
  `check_rev` on the branch (`git.rs:1455`) and `valid_positional_path` on the
  path (`:1456`). No flag smuggle could be constructed. The near-miss
  `" --upload-pack=x"` (leading space defeats `starts_with('-')`) is **not**
  exploitable: git's `parse_options` tests `arg[0] == '-'`, and `arg[0]` is a
  space. Worth tightening, not a live bug.
- **Remote dispatch is shell-safe.** `run_git` → `remote_git_command`
  (`ssh_exec.rs:638-645`) `shell_quote`s every argument individually.
- **`is_main = first` is empirically correct** (`git.rs:1381`) — git lists the
  main worktree first even when its path sorts last, and even when `worktree
  list` runs from inside a linked worktree.
- **i18n is complete.** All ten user-visible strings exist in all five locales
  (`lib/i18n.ts:2197-2207` + the four parallel blocks).

---

## Part 1 — Blocking defects

These three are what "shipped" means, and none is currently true.

### B1. The "new branch" toggle cannot ever succeed
`GitHistory.tsx:877-882` renders the branch field as a `Dropdown` restricted to
**existing** branches. `common/Dropdown.tsx:56-95` is a pure listbox — a trigger
rendering `current.label` and a `role="listbox"` of option buttons, with no text
entry anywhere. So ticking "new branch" (`:890-897`) necessarily sends `git
worktree add -b <an existing branch> <path>`, and git always answers `fatal: a
branch named 'X' already exists`. There is no combination of inputs that makes
the toggle work. Half the feature is dead on arrival.

The suite asserts only `newBranch: false` (`GitWorktree.test.tsx:81`), which is
why nothing caught it.

**Fix.** When `newBranch` is on, swap the `Dropdown` for a text input (the new
name) plus a second `Dropdown` for the start point. The start point needs a
backend argument — see B4.

### B2. Removal is one unconfirmed click that deletes a directory
`GitHistory.tsx:860-868` → `removeWorktree(wt.path)` (`:590`) with no
confirmation, from a ~10px `×` immediately beside the branch label.

`git worktree remove` refuses a *dirty* worktree but does **not** refuse on
**ignored** files — it deletes the tree wholesale. A worktree with a 900 MB
`node_modules`, a `.venv` and a `.env` full of API keys loses all three to a
mis-aimed click. No confirm, no undo, no trash.

This is out of line with the same file: lockstep resolve (`:396-401`), pairing
overwrite (`:436-445`) and backup restore (`:480-490`) all confirm first, and
`SyncConfirmDialog` exists precisely because "the receiving side holds nothing"
and "it holds the only copy" look identical from a button.

### B3. `force` is dead code — a dirty worktree can never be removed
`removeWorktree(path, force = false)` (`:586`) has exactly one call site
(`:862`), which never passes it. The inverse of B2, and both are true at once:
**the safe removal is unguarded and the deliberate one is impossible.** A
worktree with one modified file yields a raw `use --force to delete it` string
and no control anywhere in Tabtivity that can supply it.

### B4. A locked worktree is permanently unremovable
`git.rs:1490-1494` passes at most **one** `--force`. Verified:

```
$ git worktree lock --reason "on a removable drive" ../wt-lock
$ git worktree remove --force ../wt-lock
fatal: cannot remove a locked working tree, lock reason: on a removable drive
use 'remove -f -f' to override or unlock first        # exit 128
```

The parser *does* set `is_locked` (`:1398-1399`) so the UI can show the state,
but there is no `git_worktree_unlock` command and no way to pass `-f -f`. The
only escape is a terminal — for a feature whose point is avoiding one. This is
the first thing a real user hits.

### B5. Zero CSS
`grep -rn "git-worktree" src/` returns only the TSX — `-section`, `-header`,
`-title`, `-form`, `-newbranch`, `-remove` have no rules in any stylesheet.
`themes.css` gives bare `button`/`input` only `font: inherit`, so the path field
renders as a **white UA text box in a dark theme** and the remove `×` is UA grey
chrome nested inside a themed pill. `-form` and `-header` are not even flex, so
the controls stack in raw document flow. This violates the app's own
one-canonical-scheme rule.

---

## Part 2 — Silent data loss

### D1. Lockstep corrupts a linked worktree (highest severity in the audit)
`git_peer.rs:1041-1043` derives `head_branch` from a single `git symbolic-ref
--quiet --short HEAD` at the peer root — that is the **main** worktree's HEAD.
So `is_head` (`:1292`) is `false` for any branch checked out only in a *linked*
worktree, routing every ref move down the `update-ref` arm (`:1305-1310`,
`:1399-1405`, `:1816-1821`).

`update-ref`, unlike `git branch -f`, does **not** refuse. Verified:

```
$ git update-ref refs/heads/feat <new-sha>     # exit 0 — no refusal
$ cd ../wt-feat && git status --porcelain
M  a.txt                                       # phantom STAGED modification
$ git log --oneline -1
752e36a second                                 # HEAD moved under the worktree
```

For contrast, `git branch -f feat HEAD~1` correctly refuses with `fatal: cannot
force update the branch 'feat' used by worktree at '…'`.

The consequence chain is silent and real: lockstep runs in the background, the
worktree's index now disagrees with its HEAD, and Tabtivity's own commit UI does
`git add -A` + commit — so **committing from that worktree commits a revert of
the incoming change**. A `reset --hard` there destroys it outright.

**Fix.** Build the peer's checked-out-branch set from `worktree list
--porcelain` (reuse `parse_worktree_porcelain`, already present) instead of the
single `symbolic-ref` probe, then either block the ref move and report it like
the dirty-tree case, or use `git branch -f` so git's own check fires. The second
is smaller and inherits git's guarantee; the first is the honest answer for a
sync engine.

### D2. A worktree inside the project tree is byte-synced as a second full copy
Both byte-sync walkers skip entries **named** `.git` (`remote_sync.rs:462`,
`:815`), which correctly skips a linked worktree's `.git` *file* — but the
worktree *directory* is not named `.git` and is not skipped. Its entire checkout
is walked and mirrored as ordinary files.

Since no default path is suggested (see I3), "inside the project" is the natural
user answer. Result: a full second copy of the source tree pushed over SFTP,
counted in the big-folder census, landing on the peer as a plain directory with
**no `.git`** — a dead copy that then drifts. On a large repo this doubles every
sync pass. Related: `git add -A` in the parent records an embedded worktree as a
bogus gitlink (mode 160000) with a warning Tabtivity surfaces to nobody.

### D3. `copy_dir_all` cross-links two trees to one admin dir
`projects.rs:3157-3159` skips `.git` only when `is_dir()`:

```rust
if file_type.is_dir() {
    if entry.file_name() == ".git" { continue; }   // ← only a .git DIRECTORY
    copy_dir_all(&entry.path(), &target)?;
} else {
    fs::copy(entry.path(), target)?;               // ← a .git FILE lands here
}
```

In a linked worktree `.git` is a file containing `gitdir:
<main>/.git/worktrees/<name>`. Copying it produces a second directory claiming
the **same** admin entry — git operations in the copy write into the original's
index and HEAD.

### D4. The current worktree is removable
`is_main` (`git.rs:1381`) is the only "don't remove this" signal, and it answers
the wrong question: it says nothing about which worktree `project_dir` *is*. Git
does not protect the current worktree — verified, `git worktree remove --force`
on the directory you are standing in exits 0 and deletes it. Harmless today;
the moment "open worktree as project" lands, Remove on the current row deletes
the tree out from under every open terminal tab, the file watcher and the
sandbox bind mount.

---

## Part 3 — Integration with Tabtivity's own machinery

### I1. A worktree is invisible inside a project container
`sandbox.rs` bind-mounts `<project_dir>` at its identical absolute path plus a
small fixed auth/state set. A worktree outside the project dir is not mounted at
all. And a worktree *inside* it still breaks: its `.git` file points at
`<project_dir>/.git/worktrees/<name>`, so if the checkout were ever mounted
alone, git inside the container fails on a dangling gitdir.

`docs/sandbox_hardening_plan.md:312` already names this as the reason #149 (PTY
cwd confinement) is deferred: *"needs the set of legitimate roots enumerated
first (git worktrees created anywhere…)"*. **The worktree feature is the blocker
for a deferred hardening item.**

### I2. `path` has no locality semantics
`git_worktree_add` resolves remoteness from `project_dir`
(`remote_target_for_dir`), but for a remote project that `project_dir` is the
**local mirror** (`remote.rs:151-160`). So a path the user picked from a local
file tree is created **on the host**: `git worktree add
'/home/…/.local/share/tabtivity/projects/<id>/wt-feature'` runs on the login node,
creating a mirror of the mirror's path inside the cluster `$HOME`. Nothing
errors. `git_worktree_list` then returns host-absolute paths the frontend
renders as if local. The mirror's own repo can never have its worktrees managed
at all.

`git_publish.rs`'s `PublishSite` already solved exactly this "where the bytes
are is not where the operation runs" problem and is the precedent to follow.

### I3. No path containment
`valid_positional_path` rejects only empty/whitespace and a leading `-`; `..` is
explicitly accepted (`git.rs:2216` asserts it). `git worktree add <path>`
creates and populates `<path>`, so the command is a **"write repo-controlled
content to any writable absolute path"** primitive — including a path Tabtivity
would later read as intent. (`remove` is *not* a matching arbitrary-rm: git
refuses an unregistered path, so the delete side is bounded.)

A sanctioned worktrees root (`<state_dir>/worktrees/<project>/`) answers this,
I1's "what does the container mount", and the missing default path at once.

### I4. `worktree add` runs the repo's `post-checkout` hook on the host
`HARDENED_CONFIG` (`git.rs:57`) pins `core.fsmonitor` and `protocol.ext.allow`
but not `core.hooksPath`, and `worktree add` checks out by default. For a
container-toggled project `.git/hooks` sits in the container's writable mount —
the Group O #151 class. A contained agent writing `.git/hooks/post-checkout`
gets **host** execution the moment the user clicks Add worktree. Not new
(`git_checkout` shares it), but the module header documents `filter.<driver>`
as the known residual and never mentions hooks, which makes the gap look
smaller than it is.

### I5. `git worktree add` bypasses the lockstep coordinator
`checkout` deliberately routes through `git_peer_checkout` when lockstep is on
(`GitHistory.tsx:547-553`); `createWorktree` (`:571-576`) calls
`git_worktree_add` directly. On a lockstep project, adding a worktree on
`feature` checks `feature` out on the host, so the next lockstep pass wanting
`feature` there fails with `already used by worktree at …` — surfaced as a
`desynchronized` status the user cannot connect to a panel they used earlier.

### I6. `.git`-as-a-file assumed to be a directory in three places
- `projects.rs:2114` — `git_initialized` reports false for a worktree-rooted project.
- `projects.rs:2287` — scaffold preview reports `.git` **Missing**, inviting a
  `git init` that would nest a repo inside a worktree.
- `projects.rs:2484` — lockstep auto-enable is gated on `mirror/.git.is_dir()`,
  so it silently stays off with no explanation. Right outcome, wrong reason.

Everything else surveyed correctly uses `.exists()`.

---

## Part 4 — Product direction

Three rungs, each shippable on its own, each making the next cheaper.

### Rung 1 — worktree-aware tabs (the cheapest real win)

Tabtivity already has a per-tab "which machine" axis (`TabEntry.location`). A
worktree selector is the exact filesystem analogue: per-tab "which checkout" —
same mental model, same place in the UI, no new concept.

Hang it off the **subwindow (tab group)**, not the individual tab. `GroupNode`
already carries `filesFolder`/`filesOpen` for the docked file column, so a
`worktree` on the group makes the file sidebar follow the branch for free: a
group becomes *a branch workspace* — its agent, its shell, its file tree, all on
`feature-x`. Per-tab override on top if wanted. A group is also a visible,
explicit boundary, which avoids the trap the run-host preference hit (picking a
machine silently redirected every shell).

Three things must be handled or it is a footgun:

1. **It must be a declared field, not a raw cwd.** `stores/tabs.ts:3563-3566`
   and `:3626` deliberately force `cwd = defaultCwd` for agent tabs, "so stale
   saved cwds don't put the agent in the wrong directory after a project
   move/rename". A worktree agent tab would silently snap back to the main
   checkout on every relaunch — and since Claude keys its history by cwd
   (`tabs.ts:750`), `--resume` would then find no session. Add
   `TabEntry.worktree` and re-resolve it against `git_worktree_list` on restore,
   the same "minted once, survives re-minting of the tab key" pattern
   `tmuxSession` and `hostBoundUid` already use.
2. **Container mount** — see I1. On a container-enabled project the option must
   either grow the `git_common_dir` mount or be refused with a stated reason.
3. **Default outside the project tree** — see D2/I3.

### Rung 2 — worktree as a first-class project

`todo/group-e-worktree.md` defers this as a stretch goal. It is, on the evidence, the
only thing that justifies the feature's existence in Tabtivity — and it is a
composition of existing parts, not a subsystem. Verified free:

| An orchestrator must build | Tabtivity already has, keyed per project |
|---|---|
| a workspace per branch | `ProjectEntry.directory` |
| terminal + agent per workspace | `stores/tabs` scoped by project id |
| a file tree per workspace | `ProjectFilesView` |
| isolation per workspace | `SandboxSpec` → `tabtivity-<id>` (`sandbox.rs:180`) |
| switching between them | the project switcher |
| session survival | `<state_dir>/sessions/<id>/` (`storage.rs:127`) + tmux |

No collision in any of them: a new uuid means a new session dir, a new container
name, and `find_project_conflict` (`projects.rs:2545`) already refuses double
registration. `skip_scaffold` **exists** (`projects.rs:2349`, `:2515`), so
suppressing the eight scaffold files — which would otherwise be committed onto
the feature branch by the next `git add -A` — is a flag, not new work.

What it needs is an explicit marker so the four subsystems that behave wrongly
by default can be gated:

```ts
// ProjectEntry
worktree?: { parent_id: string; main_dir: string; branch: string };
```

with guards for: scaffolding (skip), lockstep/byte-sync (refuse — `reset --hard`
against a shared object store is a data-loss machine), archive (must run `git
worktree remove`, not a tree move, or the parent's `worktree list` breaks
forever), and `set_project_git_disabled` (`projects.rs:1631` does
`remove_dir_all(dir/.git)` — on a worktree it errors, on the **parent** it
silently orphans every worktree pointing into it).

**The consequence to document rather than hide:** making git work inside a
container for a worktree project means mounting `git_common_dir`, so the parent
and every worktree **share one writable object store**. Isolation becomes
filesystem-of-the-checkout only, never repo-level — and that amplifies #151
(`.git/config` is executable intent too) across N projects: an agent in worktree
A setting `core.hooksPath` executes inside the parent's and every sibling's git
calls. This belongs in `docs/context/docker_containers.md` and argues for making
worktree-as-project opt-in per project until #151 closes.

### Rung 3 — one agent per branch

- Create form gains "…and open a `<agent>` tab in it" — branch → worktree →
  project → running agent in one gesture.
- **Merge back**: from a worktree project's Git view, "Merge into `<parent
  branch>`" opens a shell in the *parent's* directory with the command staged.
  The precedent exists verbatim — `resolveInTerminal` (`GitHistory.tsx:516-538`)
  already opens a `location: "local"` shell in another directory with
  `initialInput` pre-filled.
- A parent's Git panel lists its worktree projects with live dirty/ahead
  markers — the "N agents working, here's where each is" view.

`TODO.md:76-82` calls the orchestrators (Vibe Kanban, Conductor, Claude Squad,
Crystal) "complementary, not competitive". That holds for task queues, diff
review and merge flow. It does not hold for the *container*: that half is
already built here and is currently going unused.

---

## Phased plan

**Phase 0 — make it shippable.** B1 (new-branch toggle + a `start_point`
argument on `git_worktree_add`), B2 (confirm before removal, naming the path),
B3 (`--force` re-prompt on the `use --force` error), B4 (`git_worktree_lock` /
`_unlock` + `force: u8`), B5 (theme the section next to `.git-branch-list`,
`themes.css:~7124`). Plus the cheap correctness wins: filter branches already
checked out (`GitHistory.tsx:881`, one line — `Worktree.branch` and
`GitBranch.name` are the same string space), surface `is_prunable` +
`prunable_reason` (`git.rs:1401` discards the one signal git gives, so a deleted
worktree lists as healthy) and wire the already-implemented `git_worktree_prune`
(never invoked from `src/`), `Promise.allSettled` at `:313` so the newest
command cannot blank the whole git view, and an `UntestedTag` on the section.

**Phase 1 — stop the data loss.** D1 (peer checked-out-branch set — the only
finding with silent corruption potential, and the parser to do it already
exists), D2 + D3 (treat any directory containing a `.git` entry of either kind
as a walk boundary), D4 (refuse removing the worktree matching `project_dir` —
one canonical-path comparison), I5 (interim: hide the section while lockstep is
on, with the reason stated; the real fix is D1).

**Phase 2 — locality and containment.** A sanctioned worktrees root + a
canonicalized containment check (I3), which also unblocks the deferred #149;
explicit `site: "host" | "mirror"` following `PublishSite` (I2); a default path
+ a Browse button that uses the OS picker locally and `useRemoteBrowse` /
`RemoteFolderBrowser` for a remote project; scoped `-c core.hooksPath=` on the
non-authoring commands and a header note on the hook residual (I4); the three
`.git`-`is_dir()` fixes (I6); optional `host_id` on all four commands mirroring
`slurm.rs`.

**Phase 3 — Rung 1**, worktree-aware tab groups.

**Phase 4 — Rungs 2 and 3**, worktree as project and agent-per-branch, gated on
Phase 2's containment work and the `git_common_dir` mount decision.

---

## Test plan

Every finding above is currently unguarded by CI. Present coverage: five pure
parser tests + one local roundtrip (`git.rs:1987-2089`) and four shallow TSX
tests (`GitWorktree.test.tsx`, 101 lines).

Highest value first:

1. **Lockstep × worktree** (D1) — ~15 lines of setup (`git worktree add ../wt -b
   feat`) on the existing `git_peer` harness. The single most valuable new test.
2. **`newBranch: true` payload** (B1) — one assertion would have caught it.
3. **Locked removal** (B4) and a **`prunable` fixture** — neither shape exists
   in any test today.
4. **`is_main` under adverse sort order** — every existing fixture puts main
   both first *and* alphabetically first, so a regression to "sort by path"
   would pass.
5. **From inside a linked worktree** — the roundtrip always operates from the
   main worktree, so D4 and I6 are unguarded.
6. **Remote argv shape** — nothing asserts the `cd '<path>' && git 'worktree' …`
   string, so an argv-order regression is caught only by the local roundtrip.
7. **Frontend failure paths** — no test rejects an invoke, asserts the confirm,
   or asserts `force` is sent.
8. **i18n key parity** across all five locales (`i18n.test.ts` spot-checks one
   key today).

---

## Docs to reconcile

`todo/group-e-worktree.md:4` says #23 is `[DONE]`, while `docs/Features.md:74` and
`docs/REVIEW.md:321` still list "Git worktrees (#23)" under **Open / not
started**. Given B1, "done" is the wrong label in either direction — Phase 0 is
what makes it true.

*(Done: all three now read `[DONE, UNTESTED]` / In-progress, pointing here.)*

---

## What shipped

Phases 0–2, plus the test plan. Two deviations, both deliberate.

### Phase 0 — shippable
- **B1** — the branch control swaps: a `Dropdown` of existing branches when
  checking one out, a **text input** plus a start-point `Dropdown` when creating
  one. `git_worktree_add` gained `start_point` and now returns the resolved path.
- **B2** — removal confirms first, naming the path and saying in as many words
  that git does not protect ignored files.
- **B3/B4** — `force` is a **`u8`**, not a bool. A refusal is re-offered at the
  level git itself names in the failure (`use --force` → 1, `use 'remove -f -f'`
  → 2), and `git_worktree_lock` / `git_worktree_unlock` are new commands with
  controls on every non-main row.
- **B5** — `.git-worktree-*` is themed next to `.git-branch-list`.
- Cheap wins: branches already checked out anywhere are filtered out of the
  create form; `is_prunable`/`prunable_reason` and `lock_reason` are parsed,
  shown, and wire the never-invoked `git_worktree_prune` to a Prune button;
  `Promise.allSettled` for the three git reads; `UntestedTag` on the section.

### Phase 1 — data loss
- **D1** — `PeerSnapshot.checked_out` comes from a new `worktree list
  --porcelain` section in `PROBE_SCRIPT` (still one round trip) and from the
  per-command fallback. `linked_checkout_branches` is the pure guard; a branch in
  it is **reported like the dirty-tree case, never forced** — including in
  `restore_backup`, which reaches `force_reset_branch` by a different route.
- **D2** — both byte-sync walkers now treat *any* subdirectory holding a `.git`
  entry of either kind as a boundary. The project root is exempt, or every
  project would sync nothing.
- **D3** — `copy_dir_all` skips `.git` whatever kind of entry it is, and does not
  descend into a directory holding one.
- **D4** — `Worktree.is_current` (canonicalized locally), and the backend refuses
  to remove the checkout it is running in. The UI hides the control too.
- **I5** — no longer needs the interim hide: with D1 in place lockstep reports
  the branch as blocked instead of corrupting it, so the section stays usable and
  carries a note whenever lockstep is on. **Deviation from the plan's letter**,
  which proposed hiding the section "until D1"; D1 is here.

### Phase 2 — locality and containment
- **I3** — one sanctioned root per project: `<root>/.tabtivity/worktrees/`.
  `resolve_worktree_path` takes a bare **name** (or an absolute path already
  inside the root) and refuses everything else, `..` included. That location is
  not arbitrary: `.tabtivity` is already a walk boundary for byte-sync, and it sits
  inside the directory the container bind-mounts at its identical absolute path,
  so a linked worktree's `gitdir:` pointer resolves *inside* the container — I1,
  addressed rather than deferred. `.tabtivity/` is added to the repo's own
  `info/exclude` on first use, because otherwise `git add -A` records the
  checkout as a bogus gitlink (mode 160000, verified).
- **I2** — `site: "host" | "mirror"` on all five commands, following
  `PublishSite`, with a Host/Mirror selector shown only for a remote project.
  Optional `host_id` mirrors `slurm.rs`; nothing sends it yet.
- **I4** — `NO_HOOKS_CONFIG` (`-c core.hooksPath=`, verified to suppress
  `post-checkout`) is pinned on the worktree verbs only, never on `git_commit`
  where the user's hooks are the point. `hardened_git_args` learned to pass a
  caller's leading `-c` pairs through instead of mistaking one for the
  subcommand.
- **I6** — `git_initialized` and the scaffold preview test `.exists()`; the
  lockstep auto-enable keeps `is_dir()` and now says why.
- **Deviation:** no Browse button. With exactly one legal location there is
  nothing to browse to, so the form shows the **resolved path** under the name
  field instead. A picker that refused nearly every pick would be worse than the
  preview.

### Tests
All eight items in the test plan, plus the D2/D3 walk-boundary cases: the
lockstep × worktree probe test (the highest-value one), the `newBranch: true`
payload, locked removal and a prunable fixture, `is_main` under adverse sort
order, listing and refusing from *inside* a linked worktree, the remote `cd '…'
&& git 'worktree' …` argv shape, the frontend failure paths (confirm, declined
confirm, force escalation, a rejected probe not blanking the view), and i18n
parity across all five locales — extended to catch a dropped or renamed
`{placeholder}`, which is how these strings fail in practice.

### Still open
Phases 3 and 4 (worktree-aware tab groups; worktree-as-project and
agent-per-branch), and live QA of everything above.
