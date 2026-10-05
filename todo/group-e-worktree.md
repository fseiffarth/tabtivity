## Group E — Git Worktree (new feature)
*Implemented in `src-tauri/src/commands/git.rs` + `src/components/files/GitHistory.tsx`.*

23. **Git worktree support.** [DONE, UNTESTED] Backend commands
    `git_worktree_list`/`_add`/`_remove`/`_lock`/`_unlock`/`_prune` (porcelain
    parser, registered in `lib.rs`) plus a "Worktrees" section in the history
    view (list, create from an existing branch **or a new one at a start
    point**, lock/unlock, confirmed removal with git's own force escalation,
    prune).

    The first `[DONE]` was premature: `docs/worktree_improvement_plan.md`'s audit
    found the new-branch toggle could never succeed, removal was one unconfirmed
    click, a locked worktree was unremovable from the app, the section had no CSS
    at all, and lockstep silently corrupted a linked worktree. Phases 0–2 of that
    plan are implemented — blocking defects, the data-loss set (D1–D4), and
    locality/containment (a worktree now lives only under
    `<root>/.tabtivity/worktrees/`, and a remote project chooses host vs. mirror).
    Everything is code-complete and covered by tests but **not live-verified**.

    Deferred, with the plan's own phases: worktree-aware tab groups (Phase 3) and
    "open worktree as project" (Phase 4).

    **Agent-per-branch (Phase 4, 2026-09-02) — [DONE, UNTESTED].** "+ agent"
    on a project with a linked worktree asks which worktree the agent starts in
    (`ChoiceDialog`; main first; no dialog when there is nothing to choose), and
    the chosen worktree is the tab's cwd with the branch on the label and on
    Claude's `/rename`. Restart-resume in a worktree is fixed alongside:
    `loadFromLayout` reset every agent cwd to the project root, so a worktree
    Claude's `--resume` ran from the root and found no session — a cwd under
    this root's `.tabtivity/worktrees/` is now kept (`lib/agents/agentWorktrees.ts`).
    Local projects and the mirror side only; the host side of a remote project
    (and the mobile "+ agent") still land at the root.

---
