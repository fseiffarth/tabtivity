# Threat recheck 2026-11-19 — fix plan for gaps 115, 117, 118, 119, 121, 122

Source: `docs/threat_recheck_2026_11_19_handoff.md` (evidence, reproduction,
proposed corrections) and the gap rows in `docs/threat_model.md`. Line numbers
there are as of develop `4cf65018d`; re-find by anchor text.

**In scope:** 115 (with hardening H1), 117, 118, 119, 121, 122.
**Not in this run:** 116 (waits for a check of Poetry's plugin loading and a
decision), 120 (waits for a browser test), hardening H2–H13, the unread
surfaces (#2450, #2451).

## Fixed decisions

Implementers do not reopen these.

### 115 — checkpoint restore

- The restore never resolves an agent-writable path twice. The checkpoint's
  files are checked out by the store's git into a **fresh private staging
  directory under the store** (state dir, hidden from fences), never into the
  folder. Each file is then installed into the folder **through directory
  handles**: from a handle of the bound folder, every leading component is
  opened with no-follow + directory (missing ones created through the held
  handle), the file is written under a temporary name in its destination
  directory and renamed in place on that same handle. Removals go through
  `unlinkat` on the held parent. Reuse `services::home_io`'s handle pattern
  where it fits; no bare `fs::*` on a path under the folder.
- A leading component that is a link or not a folder at install time fails
  that one path ("is a link"), as `plain_path` does today; the rest go on.
  A checkpointed symlink is installed as a link at the leaf and never
  followed; the executable bit is kept.
- The staging directory is removed on every exit path.
- Unix gets the handle-based install. Windows has no OS fence, so its arm may
  stay path-based with the check repeated immediately before each write; the
  module comment states that residual. The code compiles on Linux, macOS and
  Windows (cross-check below).
- The "agent is idle" gate stays as a courtesy; nothing security-relevant
  rests on it any more. The comments in `restore.rs` and `mod.rs` and
  `docs/context/checkpoints.md` say so and describe the new guarantee.
- H1: a path the pre-restore (undo) snapshot left out — size budget, partial
  row — is not overwritten or removed; it is reported as failed with a reason
  that says there would be no undo copy.
- Out of scope: the read-side variant during the automatic snapshot's
  `git add -A`. Report what you learn about it under "Flagged for user"; do
  not fix it here.
- Regression test (Unix): a test-only barrier between the path check and the
  install lets the test swap a subfolder for a link to an outside directory;
  the outside directory is untouched, an existing outside file keeps its
  content, and the path is reported failed. The same for a removal.

### 118, 119 — archived tabs on the phone

- The phone keeps restoring archived tabs, under the same rules as create and
  reopen. Nothing changes for the desktop's own archive UI.
- Sidecar `restore_archived_tab`: read the entry before calling the desktop
  and refuse a shell entry while the shells switch is off (the code
  `create_tab` answers), and any entry that is neither an agent nor a shell.
- Window `restoreMobileArchivedTab`: look at the entry (`tab_archive_list`)
  before taking it, and before `enterScope`; refuse with the existing
  `not_attachable` unless `phoneMayCreate` allows the kind for that scope and
  `phoneReachesTab` holds for the entry's tab. A refused call takes nothing,
  switches no scope and leaves the entry in the archive.
- `archived_tab_rows`: the agent name comes from the live list's mapping
  (binary → registry name, else the label), never from `cmd`. Rows: agent
  tabs always, shell tabs only while the shells switch is on, no other kind.
  The test in `host/tests.rs` that pins the old answer is rewritten.
- No new error code and no new user-facing string; the PWA is unchanged
  unless a fixture needs the row change.

### 117 — `shell_mask`

- Pass 3 finds a path by content, not by what precedes it: an absolute path,
  a `~/` path and a `file://` address are cut to their leaf wherever they
  start, including after `>`, `<`, `2>`, `@`, `;`, `{`, a backtick and a glued
  short flag (`-I/…`). A quoted string that is a path is masked as one path,
  spaces included. The Windows pattern gets the same treatment.
- Kept: pass 1's project-relative results, relative paths, `host:/path`,
  `http(s)://` addresses and every existing test.
- Acceptance: the synthetic lines of gap 117 in the handoff are tests in
  `shell_mask/tests.rs`, each asserting no component above the leaf remains.
- The module doc keeps saying the mask is a heuristic.

### 122 — remote agent folder

- `home_prelude`: the home is created under `umask 077` (in a subshell, so
  the agent's own umask is unchanged). The prelude then stops with a message
  on stderr and a non-zero exit, in the existing style, unless `$HOME` is a
  directory, not a link, and owned by the login (`-O`). It then sets the
  home's mode to `700` — it is the app's own leaf folder — which also repairs
  a home an older build created.
- Plain `sh` only, as the rest of the prelude.
- The setting's help line gains one sentence about a private folder. i18n
  files are edited by other sessions right now: write the English sentence
  and its key under "To apply" in the step report, do not edit `src/lib/i18n`.

### 121 — release gate

- In `release.yml`'s `wait_green`, only `ci-cd.yml` runs whose `head_branch`
  is the release branch count. A tag on a commit that has no run of its own
  on `main` is refused with a message that says so. Check whether the
  `security.yml` wait selects runs the same way and apply the same filter if
  it does; otherwise leave it and say why.
- No push and no workflow run. Validate with `actionlint` if it is
  installed and `bash -n` on the changed script text.
- Out of scope: moving the release-notes script out of the signing job (H8).

## Organisation

Shape: **disjoint subsystems, three parallel Opus implementers** (the user
asked for two to three). Each works in its own worktree on a branch off
develop `4cf65018d`, commits green there and writes a step report. No reviewer
agents in this run. The coordinating session reads the diffs, cherry-picks the
commits onto develop in order A → B → C, reruns the gates on the merged tree,
runs `backend:stale`, and updates `docs/threat_model.md`, the handoff and the
todo rows.

| Agent | Gaps | Main files |
|---|---|---|
| A — checkpoints | 115, H1 | `src-tauri/src/services/checkpoints/{restore,mod,snapshot,store}.rs`, `docs/context/checkpoints.md` |
| B — phone archive | 118, 119 | `src-tauri/src/services/mobile_control/host.rs` (+ `host/tests.rs`), `src/components/mobile/MobileBridgeHost.tsx` (+ its tests) |
| C — mask, remote home, release | 117, 122, 121 | `src-tauri/src/services/mobile_control/shell_mask.rs` (+ tests), `src-core/src/services/remote_agents.rs`, `.github/workflows/release.yml` |

Shared files nobody edits: `src/lib/i18n/*`, `docs/threat_model.md`,
`docs/threat_recheck_2026_11_19_handoff.md`, `todo/*`, the file maps,
`src/lib/untested.ts`. What belongs there goes under "To apply" in the report.

## Rules for implementers

- Worktree: the one the harness gives you. First `git checkout -B
  tr1119/<letter> 4cf65018d`, then `cp -al
  <repo>/node_modules ./node_modules`
  (hardlinks; never a symlink). Never touch the main checkout except to write
  your report.
- Cargo: `export PATH="$HOME/.cargo/bin:$PATH" CARGO_INCREMENTAL=0
  CARGO_TARGET_DIR="$PWD/target"` in the worktree.
- AGENTS.md binds, in particular: never start or stop the app; git verbs
  through `services::git_hardened`; cross-OS tests (`Path::join`, no `"a/b"`
  literals); no bare `fs::*` on an agent-writable path; no new lint warnings.
- Every fix has a regression test that fails without it. Get the baseline by
  writing the test first in your worktree, never by stashing.
- `cfg(windows)` or `cfg(unix)`-only code: run the Windows cross-check before
  committing (scratch cargo home, about three minutes cold), then delete both
  scratch directories:

  ```
  export CARGO_HOME="$PWD/target/cross-home" CARGO_TARGET_DIR="$PWD/target/cross-win-scratch"
  RC=~/.local/bin/eldrun-msvc-rc-shim AR_x86_64_pc_windows_msvc=~/.local/bin/eldrun-msvc-lib-shim \
    ~/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc \
    --all-targets --no-default-features --features desktop,voice-io -- -D warnings
  ```

- Gates before each commit: `scripts/gates-job.sh start` in the worktree,
  then `scripts/gates-job.sh status <printed directory>`; runs queue across
  sessions, so wait with blocking waits and do not poll. Tests known to flake
  under load (`host_pty`, `voice::session`, `api_proxy`, `pty_child`) are
  rerun alone before they are called failures.
- Commit on your branch with a conventional subject (`fix(checkpoints): …`),
  one commit per gap where they separate cleanly. No push.
- Report: `<repo>/tmp/threat_recheck_2026_11_19/step-<letter>.md`
  — commit shas, choices made, gotchas, gate results with test counts, what
  the fix leaves open (one sentence per gap, for the threat-model row), "To
  apply", "Flagged for user", and click-through steps for a live check.
