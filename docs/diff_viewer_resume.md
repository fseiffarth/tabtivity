# Diff viewer + sync resolver run — resume here

Paused 2026-11-05 at the user's request. Nothing is on `develop` yet and
nothing was run live. To continue: read this file, then the per-agent
handoffs it names (each has a **Resume** section at the top).

## Where everything is

| Part | Branch | Worktree (`.claude/worktrees/…`) | Commits | State |
|---|---|---|---|---|
| Integration (A+B merged onto develop `6e36fd30`) | `diff-integration` | `diff-integration` | `ed80c593` A, `760f3df8` B, `bd882a47` merge fixes, + this doc | build green, lint clean on changed files, viewers/terminal/i18n vitest 1344/1345 (the 1 = `TerminalAiSwitch` timeout, 4/4 alone). Full suite not run. |
| A — parser, word marks, theme tokens | `worktree-agent-a17b139159945edc0` | `agent-a17b139159945edc0` | `157ad310` | done; handoff `docs/diff_viewer_handoff_A.md` |
| B — split view, change nav, file index, folds | `worktree-agent-ac84388c94ef34606` | `agent-ac84388c94ef34606` | `9da1bd52` | done; handoff `docs/diff_viewer_handoff_B.md` |
| C — loading hook, bug fixes, big-diff caps, states | `worktree-agent-ae9230fc338dc223d` | `agent-ae9230fc338dc223d` | `ef30df5b` (wip), `495b38f1` docs | **wip**: build/full vitest/cargo test/backend:stale not run; handoff `docs/diff_viewer_handoff_C.md` |
| D — sync resolver times + "Hand to an agent" export | `worktree-agent-abf751677bf453196` | `agent-abf751677bf453196` | `801cea67`, `a29e3a33` (wip) | **wip**: full build, `cargo test --workspace`, `core_dispatch` test, backend:stale not run; handoff `docs/sync_resolver_handoff_D.md` |

**All four agent branches start from `origin/main` (`b07d96c9`), not
develop** — the worktree isolation branched from the default branch. Land
them by cherry-picking onto `diff-integration` (as A and B were), never by
merging the agent branches (that would drag main's merge commits in).

## Next steps, in order

1. **C onto `diff-integration`**: `git cherry-pick ef30df5b 495b38f1`.
   Expected conflicts: `DiffView.tsx` (B's render tree vs C's data section +
   state rows), i18n ×5, `untested.ts` (union-resolve: keep both sides' keys,
   dedupe by key — the script used for B is easy to redo).
   - B's layout must render through C's `drawn.files` / `drawn.lines` (row
     cap), not `files` / `wholeHunk.lines`; B's whole-file folds and C's
     1500-row window both shape whole-file mode — keep C's window, apply B's
     folds inside it.
   - C strips the diff's final `\n` before parsing to dodge a phantom blank
     line; A's parser already fixed that bug — keep or drop the workaround
     (harmless), but check `wholeFileHunk` works on a real git diff either way.
   - C touched `src-tauri` (`git_diff_file`: staged-only diff, outside-repo
     message) + 2 Rust tests never run.
2. **D onto `diff-integration`**: `git cherry-pick 801cea67 a29e3a33`, then
   reword `a29e3a33` from `wip`. D touched `CompareView.tsx`,
   `SyncMergeView.tsx`, the side panel's diverged list, backend
   `sync_handoff_export` / `sync_handoff_load_resolved`, `command_class`,
   `commandClasses.ts`, `core_dispatch.rs` (two unconfirmed `USER_CONFINED`
   rows). develop moved 150 commits past D's base — expect backend conflicts;
   regenerate `commandClasses.ts` after resolving.
3. Gates on the integration worktree: `scripts/gates.sh --all` (incl.
   `cargo test --workspace`, the daemon build, clippy ×3),
   `cargo test -p tabtivity --lib -q core_dispatch`. Re-run any timeout
   failures alone.
4. Final review (one reviewer over `develop..diff-integration`): cross-agent
   integration, i18n keys, untested rows (`diffView.wordMarks`,
   `diffView.layout`, `diffView.states`, `compareView.sideTimes`,
   `syncHandoff.resolver`, `syncHandoff.panel`), filemap rows, brand, privacy.
5. Land on develop (fast-forward `develop` to `diff-integration` if develop
   hasn't moved; else rebase the integration branch first), then
   `npm run backend:stale` and give the user the click-throughs from the B,
   C and D handoffs.

## Flagged for user (decide before or after landing)

- D's export folder is `~/handoff/<id>/` inside the project's **agent home**
  (only place outside the project a fenced agent can read/write). Hard to
  browse to: add a "reveal folder" button, or another location?
- Host-side agent tabs can't see that folder; only local agent tabs are offered.
- Word marks treat an identifier as one token (`isAdmin`→`isOwner` marks it
  whole) — split camelCase?
- `n`/`p`/F7 change-nav keys are fixed; make them rebindable like steering?
- New colour tints (15 % line / 38 % word) and all de/es/fr/it strings unseen.
- Not fixed: a renamed file with edits (`git diff -- <path>` can't see
  renames); a file with staged + unstaged edits shows only unstaged.
- Sync resolver loads the local side with `.catch(() => "")` — an unreadable
  mirror file looks empty (C noticed; D may or may not have touched it —
  check D's handoff).
- Per-change "newer" compares times across two machines (clock skew).
