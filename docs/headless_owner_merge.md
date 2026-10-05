# Headless owner — merging the branch into develop

*The H1–H3 headless owner and the "keep running when closed" switch live on
branch `headless-owner` (worktree
`.claude/worktrees/headless-owner`). Design and live checks:
`docs/headless_owner_handoff.md` on that branch; plan:
[`headless_owner_plan.md`](headless_owner_plan.md).*

*Written 2026-10-02, while develop (`380dba4f`, post-rename) was being merged
into the branch. The branch has never run live, and H1 rewrites saved state
for every user, not only behind the "keep running" switch: session files gain
`workspaceVersion` and new tab ids, settings and boxes gain `rev`.*

1. **Finish the develop → branch merge in the worktree.** Resolve the conflicts (the
   2026-10-02 merge had 25: i18n dicts, `untested.ts`, `tabs.ts`,
   `schema/settings.rs`, `schema/boxes.rs`, `mobile_control`, the filemaps).
   Code written before the rename may still spell the old name, so it must
   go through `crate::brand` / `src/lib/brand.ts`; `scripts/brand-check.sh`
   has to pass, not just the merge itself.
2. **Gates in the worktree:** `npm run build`, `npm test`, `cargo test`,
   `npm run lint`, clippy with `-D warnings`, `scripts/brand-check.sh`,
   `scripts/privacy-check.sh`.
3. **Develop hasn't moved:** `git merge-base develop HEAD` must equal
   `git rev-parse develop`. If it moved, merge develop in again and repeat 2.
4. **Main checkout clean where the branch touches it:** uncommitted work
   there (e.g. the i18n dicts) makes `--ff-only` refuse. Get it committed
   first.
5. **Back up your sessions (the state dir).** Run it in a normal terminal or
   the root console's Host session; a fenced tab sees the state dir masked
   (empty JSON files, an empty `sessions/`), so a backup taken there is
   empty. If the dev window was started by the dev-sandbox launcher, its
   state dir is `$TABTIVITY_STATE_DIR` instead (`echo` it in a shell tab).
   ```bash
   du -sh ~/.local/share/tabtivity
   tar -czf ~/tabtivity-state-$(date +%F-%H%M).tar.gz -C ~/.local/share tabtivity
   # if agent-homes makes it too big (sessions, tabs, settings, boxes,
   # calendar, projects all live outside it):
   tar -czf ~/tabtivity-state-$(date +%F-%H%M).tar.gz -C ~/.local/share \
     --exclude='tabtivity/agent-homes' tabtivity
   ```
6. **Merge, on develop in the main checkout:**
   `git merge --ff-only headless-owner`, then
   `npm run backend:stale`. The new frontend hot-reloads into the running
   window on top of the old backend, so expect it to report stale. Merge
   when you are ready to restart Tabtivity yourself right after.
7. **Push** through `git_push` (pre-push runs the privacy check and bumps the
   version).
8. **Live checks:** the "Manual checks owed" lists in
   `docs/headless_owner_handoff.md` (H1, H2, H3).
   The untested pills stay until each item is confirmed.
9. **Clean up:** `git worktree unlock` and `git worktree remove
   .claude/worktrees/headless-owner`, then
   `git branch -d headless-owner`.

**Rollback:** quit Tabtivity, check out the pre-merge develop and rebuild,
restore the backup, *then* launch. An old build must not read the rewritten
files:
```bash
rm -rf ~/.local/share/tabtivity && tar -xzf ~/tabtivity-state-<stamp>.tar.gz -C ~/.local/share
```
