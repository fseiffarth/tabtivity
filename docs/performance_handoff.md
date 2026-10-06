# Performance plan — handoff

*One section per agent step of [`performance_plan.md`](performance_plan.md)
§11. Each step's implementer appends its own section; its reviewer appends a
"Review" subsection. Nothing here was run live unless a section says so.
Worktree: `.claude/worktrees/perf`, branch `perf`, created from `develop` at
`a6ed2c7a`.*

Section template:

```
## S<n> — <title>

*Written <date> by the S<n> implementer. Base `<sha>`. Nothing run live.*

### Commits
| Commit | Content |

### What was built / choices made
### Gotchas for later steps
### Gates (worktree)
| Gate | Result (with test counts) |
### Flagged for user
### Live click-through (user)

### Review (S<n> reviewer, <date>)
- range reviewed, bugs fixed (sha + regression test), gates after, flagged
```

## S1 — backend quick wins

*Written 2026-10-06 by the S1 implementer. Base `be7260da`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `2857a41a` | §7.1 state-file commands off the GTK thread (ordered lane) + `patch_json` no-op skip |
| `ecb98708` | §7.3 `agent_auth` keeper stat gate |
| `8440c3a8` | §7.2 quick wins: relaxed descendant cache for the header poll, GPU section cached 10 s |

### What was built / choices made
- **§7.1, ordering kept:** not `#[tauri::command(async)]`. Tauri's pool loses
  arrival order, and the window does not serialise all of these calls itself
  (`updateSettings` fires `patch_settings` without awaiting the previous one;
  `save_projects` callers overlap) — two back-to-back saves could land in either
  order. Instead `commands::persist_lane::ordered` wraps the generated invoke
  handler in `lib.rs`: the ten state-file commands (`get/save/patch_settings`,
  `save_window_state`, `get/save_projects`, `load_tab_session`,
  `workspace_snapshot`, `workspace_sync`, `save_tab_layout`) are queued, in
  arrival order, on one worker thread (`services::ordered_lane`, FIFO, lazy,
  panic-tolerant); their bodies are unchanged sync fns. Reads are on the lane
  too, so read-after-write still holds. `RunEvent::Exit` drains the lane
  (5 s bound) before teardown. Ordering against *other* sync commands is no
  longer guaranteed — the same as any off-thread approach.
- `patch_json` compares the serialised bytes with what it read and skips the
  temp-file + two fsyncs when equal (no `durability::record` entries either).
  A missing file is still created; a file in another layout (compact, no
  trailing newline) is still rewritten once. `save_window_state` always bumps
  `rev`, so it never no-ops (the frontend already skips equal geometry).
- **§7.3:** `reconcile_file` sits behind a stat gate: a pair (home copy, store
  file, placed sidecar) last seen *settled* (home bytes == store bytes, nothing
  written) is skipped while all three `stat` identically (len, mtime, and on
  unix dev/ino/ctime). A stamp whose mtime is younger than 3 s is never
  trusted (coarse-timestamp same-length rewrite). A pending or refused
  adoption is never cached (it also depends on the home's account file).
  **Poll stays 5 s**: a `notify` watcher on the store dir would only see the
  place direction; logins land in homes, and a 60 s poll would delay their
  adoption into running sibling tabs by up to a minute. The stat pass is a
  few `stat`s per home × CLI × path. "Skip homes with no live tab" not done:
  `services/` has no tab registry (plan item left for S11, which gets one).
  `link_claude_identity`/`strip_claude_identity` still read `.claude.json`
  per home per pass (small, not in the plan's list).
- **§7.2:** `CACHE_TTL` (1.5 s) stays the default — the Windows/macOS
  `find_window_for_pid` retry loops poll `descendant_pids` for a launcher's
  just-forked child and cannot be compile-checked here, and the CPU pills want a
  fresh tree. New `descendant_pids_relaxed` (4 s) is used by
  `debug_app_resource_usage` (the 2.5 s header poll), so that poll now hits
  the cache. The GPU half of that command (`total_vram_in_use` loopback +
  `gpustat::snapshot`) is cached 10 s (`reuse_within`).
  `running_outputs` left as is: it already returns before any walk when no
  background shell is open; restricting to agent_turn's shell pids needs the
  per-tab pid plumbing S11's `proc_table` brings.

### Gotchas for later steps
- S11: any new state-file command must be added to `persist_lane::ORDERED`
  if a caller relies on save-then-read ordering.
- `cargo test` filters: `storage::tests`, `services::ordered_lane`,
  `commands::persist_lane`, `agent_auth::tests::{an_unchanged_login,a_changed_size}`.

### Flagged for user
- Plan §7.2 says `debug_app_resource_usage` reaches `gpustat::amd_fdinfo_procs`.
  It does not: that walk is only in `process_snapshot()` (the monitor pane's
  per-process list, already cached 1 s). The header path calls `snapshot()`.
- Plan §7.1 proposes `command(async)`; the lane was chosen for the ordering
  reason above. If a reviewer prefers the plan's form, `updateSettings` and
  `save_projects` callers need frontend serialisation first.
- Behaviour change to feel: `settings.json`/`projects.json`/session files no
  longer fsync when the content is unchanged; file watchers on them fire less.

### Live click-through (user)
1. Rename and reorder tabs while an agent streams: no stall (§7.1).
2. `inotifywait -m <state_dir>/projects.json` while switching projects: no
   MODIFY/MOVED_TO events for an unchanged list (no-op skip).
3. Sign in to a CLI in one tab; a sibling tab of another scope sees the login
   within ~5 s as before (§7.3 gate must not delay it).
4. `pidstat -p $(pgrep -f tabtivity | head -1) 5` at idle: backend CPU lower
   than before (§7.3 + §7.2).
5. Quit with unsaved layout changes made in the last second: layout restored
   on next launch (lane drain at exit).

### Review (S1 reviewer, 2026-10-07)
Range `be7260da..c9a339f1` (`2857a41a`, `ecb98708`, `8440c3a8` + handoff).
**No bugs confirmed; no code commits.** Checked and found sound:
- Lane wrapper: non-lane commands pay one 10-entry string scan, no
  allocation, no blocking; a lane command's body runs unchanged and answers
  through Tauri's thread-safe resolver (the same path async commands use).
  The worker is spawned once (lazily, under the sender mutex); `drain` posts
  a sentinel and waits ≤ 5 s on the main thread at `RunEvent::Exit`.
- Quit: `AppShell.onCloseRequested` awaits `save_window_state`, the layout
  flush and `shutdownDetachedWindows` before `destroy()`, so those saves are
  on disk before Exit; the drain only covers the exits that never run
  frontend code (SIGTERM → `app.exit`). No lane command needs the main
  thread (`workspace_sync`'s emit posts to the event-loop proxy without
  waiting; `invalidate_copilot` → `stop_all_now` is non-blocking).
- No deadlock: lane jobs take `JSON_MUTATION_LOCK` + the file lock, which
  the main thread never holds while waiting on the lane. A panicking job is
  caught; the lane continues, that one promise never settles (Tauri's own
  async commands behave the same on panic). Read-after-write holds:
  `get_projects` after `save_projects` from the same window is FIFO.
- `patch_json`: compares `to_vec_pretty` + `\n`, the exact bytes
  `write_bytes_atomic_unlocked` writes; both locks still release on the skip;
  legacy normalisation (`get_projects`) still rewrites since its bytes differ;
  `patch_settings`/`save_window_state` bump `rev` and never no-op.
  `services::remote`'s `(mtime, len)` projects cache stays consistent (same
  bytes, same stamp).
- `agent_auth` gate: a stamp is recorded only when every mtime is ≥ 3 s old,
  so an equal-length rewrite lands ≥ 3 s after the recorded mtime — distinct
  on any filesystem with ≤ 2 s granularity; `symlink_metadata` means a
  symlink swapped in stats differently; unix adds dev/ino/ctime. A pair is
  cached only when `reconcile_file_now` wrote nothing and found home == store
  — adoption, refusal and placement all take the full path, so logins stay
  shared per CLI. Test `an_unchanged_login_is_not_read_again` counts full
  passes through a thread-local, so it does exercise the gate.
- `descendant_pids_relaxed`: keyed per sorted root set; a 1.5–4 s-old entry
  now survives `retain` but the default lookup still recomputes past 1.5 s
  (`relaxed_lookup_reuses_an_entry_the_default_would_recompute`). Neither
  cache holds its mutex across the `/proc` walk or the GPU read.
- Cross-OS: `cargo check --target x86_64-pc-windows-msvc` (RC/lib shims)
  passes; the range has no macOS-only code.

Gates after (worktree, 2026-10-07): `npm run build` ok · `cargo test -q`
3722 passed, 0 failed · `npm run lint` 0 errors, 28 warnings (pre-existing;
the range touches no TS) · `cargo clippy --all-targets -D warnings` clean ·
`scripts/brand-check.sh` ok · `git diff --check` clean · `npm test` not run
(no frontend change in the range).

**Flagged for user**
- Ordering against non-lane sync commands is gone (as the plan's own
  `command(async)` form would also lose it). Concrete shape: a `void
  setActive()` / `updateSettings()` followed at once by a sync command that
  reads `projects.json` (`fs.rs` `allowed_roots` with no scope, `boxes.rs`,
  `project_runtime.rs`) or `settings.json` (`ide.rs`, `browser.rs`,
  `mail.rs`, `ollama.rs`) can read the pre-save file while the lane is mid-
  fsync. `save_projects` merges status/position by id, so nothing is lost,
  only briefly stale. No caller found that depends on it; not fixed.
- A lane job that panics leaves its JS promise pending (before, the panic
  would have unwound the GTK thread). The quit path awaits lane promises, so
  a panic in `save_window_state`/`save_tab_layout` at quit would stall the
  close handler until the user kills the window. Not seen; left as is.
- The implementer's section has no "Gates (worktree)" table; the counts
  above stand in for it.
