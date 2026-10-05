# Git lockstep + byte-sync

Referenced from `AGENTS.md`. The step-by-step *how it works* (colours, menu
items, pass order, symptom → fix) is `docs/remote_sync_guide.md`; this file is
the *why*.

- **Two transports keep a remote project in step, and they split the tree by
  git.** *Git lockstep* (`services::git_peer`) owns the **git-tracked** files and
  moves them **semantically** — commits and refs via `git bundle`, never `.git`
  bytes. *Byte-sync* (`services::sync_auto`) owns **everything else** and moves raw
  bytes. `drop_tracked` enforces the split so the two never race for one file. One
  consequence to internalize: with lockstep on, a saved edit to a **tracked** file
  no longer reaches the host until it is **committed** (`docs/git_lockstep_case_matrix.md`
  #5/#7). Live-QA log: `docs/git_lockstep_live_qa.md`.
- **Anything the sync destroys on the local side says so** (#28q, `services::local_loss`).
  Byte-sync is non-destructive *by construction* — it pulls only when the local side is
  unchanged, pushes only when the host is, and skips a both-sides-changed file rather than
  pick a winner — so every local **deletion** comes from the git side: a fast-forward,
  `reset --hard` or checkout on the mirror drops the tracked files the incoming commit no
  longer carries, and the `git clean` that un-blocks a refused fast-forward removes
  untracked ones outright. Correct, git-recoverable, and *silent* — which is the problem,
  because it happens during background passes nobody triggered. Each site now files a
  warning that `LocalLossDialog` raises. The exception that is **not** recoverable, and is
  labelled as such: a confirmed manual pull overwriting a mirror file that held
  unsynced local edits (resolving amber by choosing the host). It is a **log file**, not an
  event: the services are `AppHandle`-free and a background pass can delete with no window
  listening, so a loss recorded while the app was closed still surfaces on next launch.
- **Every manual transfer asks first** (`stores/remote/syncConfirm` → `SyncConfirmDialog`,
  priced by the read-only `sync_transfer_preview`). The clause above — "non-destructive
  by construction" — describes the *background* engine, which skips a both-sides-changed
  file rather than pick a winner. The **manual** transfers are exactly the ones that do
  pick: a pull writes the host's bytes over the mirror's, a push writes the mirror's over
  the host's, and each used to be one unconfirmed click — on a file, on a **folder**
  (whole subtree), or on the whole project. From the button alone the safe case (the
  other side holds nothing) and the lossy one (it holds edits held nowhere else) are
  indistinguishable, which is what made an ordinary misclick destructive. So the click is
  now a question that states direction, scope, file count and size, how many files land
  on top of an existing one, and **by name** the receiving-side files whose content would
  be gone — the same rule `local_loss` files a warning for afterwards, asked before
  instead. A preview that fails, or a tree too big to inspect up front, says so and still
  requires the answer: a missing price is never an implicit yes. Covers the file tree's
  ⇄ button and its sync/push menu items, the file view's whole-project "Sync all" in both
  directions, and the diverged-files list's per-row and bulk take-a-side actions (which
  are force transfers, and are labelled as such).
  - **The tracked-tree split applies to manual transfers too.** Preview, pull, and
    push all subtract the lockstep-owned tracked set before moving bytes. The
    confirmation names how many files were withheld and explains that they travel
    after commit, so a whole-project byte push cannot dirty the peer and wedge the
    next fast-forward.
  - **A conflict queue can be dropped whole ("Skip all").** A push that a host change
    would clobber is blocked per file and queued for a keep-local/take-host answer; over
    a folder or a whole project that queue can be hundreds long, and answering it file by
    file is not a decision anyone can make at that size. "Not now" is a legitimate answer
    and is the safe one: skipping writes to neither side, so the files stay diverged and
    stay in the file view's **orange** list, where the merge viewer resolves them one at
    a time and the bulk take-a-side buttons resolve them together. The dialog says so
    rather than leaving "skip all" reading as giving up.
- **Lockstep is ON by default for a new git-backed remote project** — set at
  creation by both `create_project` and `extend_project_to_remote` (gated on the
  mirror actually being a repo). It is safe as a default precisely there: the host
  root was just created empty, so the first pass can only seed one direction, and a
  host dir that already holds *differing* files makes pairing **refuse** and ask
  (`pairing_conflict`) rather than clobber. It is written as explicit per-project
  state, never as `GitPeerState::default()` — `load_state` falls back to that
  default for every project with no state file, so flipping it there would silently
  enable lockstep on existing projects that never opted in.
- **A file the manifest has never seen is still reported** (`sync_status`'s
  new-local-file pass → `SyncState::LocalNew`). Everything else in the status
  view iterates the manifest, so a file *created* in the mirror after the last
  transfer used to be invisible everywhere at once: the remote tree lists the
  host's readdir (which doesn't have it), the amber list only knows manifest'd
  files, and no auto marker meant no engine pass ever discovered it — SimpleGNN
  accumulated ten new configs/tests with nothing anywhere saying "these exist
  only locally". The pass lists the mirror (git-backed: `ls-files -co
  --exclude-standard`, because .gitignore is the honest noise filter there —
  the caches/venvs a raw walk would report as thousands of "new" files are
  exactly what the user chose not to version; non-repo mirrors fall back to the
  raw walk, capped), drops manifest'd, excluded and — with lockstep on —
  tracked paths (those travel as commits, #28p D1), and reports the rest as
  upload-offers: a green ⬆ on the file row and its ancestor folders, and a
  "new local files" section beside the diverged list. Deliberately **advisory,
  one-directional and unsynced-by-default** — nothing transfers until the
  click, and the click is the ordinary confirmed push.
- **Byte-sync is opt-in per path and does not read `.gitignore`.** Scope comes from
  an explicit manifest (`is_auto`: nearest marker wins, root `""` = project-wide);
  no marker ⇒ nothing crosses. This is what leaves a remote project's *deliberately
  host-side* data — experiment output, checkpoints, everything gitignored and hence
  invisible to lockstep — on the host. The corollary is that the two systems have
  **different notions of scope**, so marking a folder auto-sync is the one click
  that can haul a multi-GB tree into the mirror; the file tree prices the host
  subtree first (`sync_auto_preview`) and confirms when it is large.
  - **The giant folders are asked about once, at setup, on both sides**
    (`services::big_folders` → `BigFolderExcludeDialog`). Pricing one folder on the
    click that syncs it is too late for a project whose `node_modules/`, `.venv/`,
    `data/` or `checkpoints/` was there before Tabtivity was: nothing else in the app
    would ever mention them, since byte-sync doesn't read `.gitignore`. So a
    project newly created/imported as remote, or **extended** to a host, gets one
    census — the local mirror walked directly, the host in one `du -ak` round trip
    (skipped, never attempted, at a cold pool: dispatching at a dead session is
    what freezes the window) — and one prompt listing each side's numbers, ticked
    to **exclude** by default. The answer is a manifest `excluded` marker, which is
    deliberately *stronger* than `auto_off`: it is honoured by the whole-project
    pull and push too (`is_excluded`, whose `under` waives only the marker on the
    path the user explicitly asked to transfer), and it makes the rsync fast path
    stand down, since a whole-subtree rsync cannot honour a carve-out. Byte-side
    only — a **git-tracked** file in an excluded folder still travels as a commit.
  - **The rsync pull path is only a transport optimisation.** It consumes the
    host walker's exact regular-file list (NUL-delimited), rather than widening
    a folder pull back to the raw subtree. That keeps the confirmation preview,
    manifest accounting, and transferred bytes on the same path set: `.git`,
    `.tabtivity`, nested repositories, and symlinks remain outside byte-sync even
    when rsync is available on both ends. If that allowlist cannot be confined
    to the requested subtree, the transfer falls back to the SFTP path.
- **Concurrent writers are serialized at their ownership boundary.** Every
  lockstep reconcile—poll, watcher, retry, checkout, pairing, resolve, or backup
  restore—takes the same per-project async guard before touching bundle paths or
  `git_peer.json`. Worker fan-out has the equivalent per-project/host in-flight
  guard, including its manual button. The local-loss journal locks its complete
  read-modify-write so simultaneous warnings cannot erase one another.
- **Byte pulls replace local files atomically.** Host bytes are fully read and
  staged beside the mirror destination before rename, matching the push side's
  temp-and-rename rule. A crash therefore leaves an old or new complete mirror
  file, not a truncated file that masquerades as a divergence.
- **A commit is not a checkout** (`head_target_moved`). Head-move detection
  compares the checkout *target* — branch name, or the sha while detached — not
  the whole `HeadRef`. Comparing shas made every commit on the mirror replay as
  `git checkout <branch>` on the host, which is a no-op while both sides sit on
  that branch and a silent branch switch on the host (under its running jobs)
  whenever they do not. When **both** sides changed target since the last look,
  no side is picked: the pass reconciles refs only and `head_mismatch` reports
  it, exactly as for any other case where there is no principled follower.
- **A pass must not wake itself.** Every pass writes inside the mirror's `.git`
  (bundle, `refs/tabtivity/*`, fetched objects, `index`) — the directory the
  lockstep watcher observes. While green the D5 early-out absorbed that; while
  red nothing did, so a diverged or blocked project re-ran the full SSH pass
  every debounce window. `poll_loop` now records the mirror's ref signature
  after each pass and skips a watcher burst that leaves it unchanged
  (`watcher_burst_is_own`); the 12 s poll still covers anything real in that
  window. Byte-sync's mirror watcher ignores `.git`/`.tabtivity` outright
  (`event_touches_synced_bytes`) — it never moves a byte of either, and every
  lockstep pass used to cost it a host walk.
- **Lockstep-owned rows are not stat'd** (`sync_status`). The pairing seed puts
  every tracked file in the manifest so the tree reads green, but with lockstep
  on their bases go stale the moment a fast-forward rewrites the *other* side;
  stat'ing them painted every committed change amber/orange until the content
  check healed it (never, over the 1 MiB cutoff), with pull/push buttons that
  `drop_lockstep_tracked` then refused. They are reported green, unchecked, and
  a targeted pull/push of one says why it moved nothing instead of `Ok(0)`.
- **Auto-on lifts the path's own exclusion.** `is_auto` and `is_excluded` both
  consult `excluded` before `auto_sync`, so an entry carrying both stayed
  excluded — *Auto-sync this folder* on a giant-folder-excluded tree flipped the
  glyph and changed nothing. `sync_set_auto(true)` clears `excluded`; the
  store patches the same.
- **A linked-worktree block needs a write** (`would_move_ref`). Only a create,
  a fast-forward, or a forced reset writes the dest's ref; a dest-ahead branch
  under a plain reconcile is the *other* leg's fast-forward, and blocking it
  reported a red "left alone" for every worktree that was merely ahead.
