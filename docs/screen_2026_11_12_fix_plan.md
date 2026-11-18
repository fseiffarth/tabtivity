# Screen 2026-11-12 — fix plan for the High items

Source: `docs/whole_project_screen_2026_11_12.md`, section "High — fix first"
(items H1–H13 below keep its numbering), plus the one Medium that shares a
file with H3 (bundle `state/` adoption). Everything else in the screen is out
of scope for this run. Line numbers are as of develop `214933ab5`; re-find by
anchor text.

## Fixed decisions

Implementers and reviewers do not reopen these.

- **H1 root-scope sandbox flag.** `services::sandbox::enforce_spawn_authority`
  with no project id forces `opts.sandbox = false` (the root console has no
  container). Independently, in `launch_prep.rs` the fence match's catch-all
  `_ => {}` becomes fail-closed for a local agent: a local agent whose
  decision is `NotApplicable` proceeds only if it was actually docker-wrapped
  (`sandbox && !local_only` at wrap time), ssh-wrapped (remote run), is the
  explicit Host session, or is not an agent (`"shell"`). Any other case returns
  `Err`. Regression tests for both layers.
- **H2 `host` scope key.** `storage::is_reserved_scope` also reserves
  `agent_home::HOST_SCOPE_KEY` (same folding: trim, `project_key`, ASCII
  case-insensitive), so project create/import/registries refuse it the way
  they refuse root/assistant. Fix the vacuous test at `agent_home.rs:788` so it
  asserts the real non-collision through `is_reserved_scope`. **Not** in scope:
  moving the Host home folder, or the `box_x` vs `box:x` fold (record under
  "Flagged for user").
- **H9 tmux targets.** `local_tmux_kill_args` / `local_tmux_rename_args` use
  the `=<name>` exact-match target, like capture-pane already does.
  `local_tmux_kill` validates the session name with the same check its sibling
  commands use before building argv.
- **H11 worker fan-out.** A sync request for a worker that already has one
  running is no longer dropped: it sets a per-worker "rerun wanted" flag, and
  the running sync loops once more on finish with the newest HEAD (coalescing:
  at most one queued rerun). Push-only and tracked-files-only are unchanged; no
  `git clean`. The return value says "queued", not "skipped".
- **H3 bundle links.** In `project_transfer::extract_section`, a symlink is
  created only if no component between the import root and the link's parent
  is itself a symlink (`symlink_metadata` walk); otherwise it is skipped and
  reported like the existing Windows "missing link" gap. Same section: the
  remote-project import keeps only the files the export allows
  (`REMOTE_STATE_FILES`) from the bundle's `state/` section and drops the rest.
- **H4 fetch.** `fetch_local` goes through the same exec_trust gate as the
  hooked verbs (`require_hook_trust` or its equivalent). The trust fingerprint
  must cover the program-running config keys fetch honours (`core.sshCommand`,
  `credential.helper`, `remote.*.uploadpack`, `url.*.insteadOf`); if it does
  not today, extend it. Untrusted → the same refusal/approval UX the hooked
  verbs already show; no new UI.
- **H5 box agent docs.** `write_box_agent_docs` reads and writes through the
  no-follow helpers (`write_no_follow` and a regular-file check); a link or
  non-regular file is skipped and logged, never followed.
- **H6 known_hosts.** `ssh_trust_host_key` stops trusting caller text. The
  backend takes the host (and port), scans it itself, and writes only lines
  that match the key fingerprint the user was shown, with the host field equal
  to the requested host; it refuses `@cert-authority`/`@revoked` markers,
  wildcards and negations. The command name and class stay; the frontend
  caller is updated to the new arguments. Where it writes (the user's
  `~/.ssh/known_hosts`) is unchanged; record under "Flagged for user" that it
  edits another app's file.
- **H8 poetry.** The `poetry env info -p` probe runs only for a project
  exec_trust has approved; otherwise it is skipped silently (discovery probes
  are optional by design). No new prompt.
- **H7 phone login payload.** The PWA builds the login payload itself from the
  nonce and expiry (as `secretsCore.actionPayload` does for actions), compares
  it to the server's `payload`, and refuses to sign on mismatch. No server-side
  change, so current desktops keep working. Unit test for the mismatch path.
- **H10 unsaved file tab.** Closing a dirty file tab with autosave off asks
  through `useDialogs()` (Save / Discard / Cancel; Cancel keeps the tab open).
  New strings go in `src/lib/i18n/en.ts` (and any other dictionary file
  that must hold every key). `closeTabWithConfirm` actually confirms.
- **H12 pre-push bump.** The version bump runs only when the pushed local ref
  is the checked-out branch (`git symbolic-ref -q HEAD` equals `local_ref`).
  Any other branch push passes through un-bumped, with a one-line note; the
  privacy scan of what is published is unchanged.
- **H13 release ordering.** `release.yml` additionally waits for `security.yml`
  to succeed on the same commit, the same way it waits for `ci-cd.yml`. Pins
  stay SHA-pinned. No push and no run of the workflow in this plan.

## Organisation

Shape: **disjoint subsystems, three parallel implementers** (the user asked for
three). Each runs in its own worktree reset to develop, commits green on its
own branch, and writes its own handoff file. The coordinating session reviews
the diffs, cherry-picks the commits onto develop in order A → B → C, reruns
gates on the merged tree and runs `backend:stale`. No reviewer agents in this
run; the user may ask for them after.

Hot shared files (`src/lib/i18n/*`, `services::command_class` +
`src/lib/transport/commandClasses.ts`, `src/lib/untested.ts`, the filemaps):
only C may touch i18n; only B may touch `commandClasses.ts` (if H6 changes the
arguments of a command, which doesn't change its class row). Filemap rows and
anything else shared go in the handoff as "to apply", not into the files.

## Agent steps

| Agent | Items | Main files |
|---|---|---|
| A — fence, spawn, tmux, worker | H1, H2, H9, H11 | `services/sandbox.rs`, `services/launch_prep.rs`, `storage.rs`, `services/agent/agent_home.rs`, `services/tmux_local.rs` (+ its command), `services/remote/worker_sync.rs` |
| B — untrusted input → host | H3 (+ `state/`), H4, H5, H6, H8 | `commands/project_transfer.rs`, `commands/git_pull.rs` (+ `services/exec_trust.rs` if the fingerprint needs the keys), `commands/boxes.rs`, `services/remote/ssh_common.rs` + its command and frontend caller, `commands/python.rs` |
| C — phone, editor, hooks, CI | H7, H10, H12, H13 | `mobile-web/src/auth.ts`, `src/components/embed/draftSaver.ts`, `src/lib/remote/closeRemoteTab.ts` (+ caller), i18n, `.githooks/pre-push`, `.github/workflows/release.yml` |

Handoffs: `docs/screen_2026_11_12_fix_handoff_{a,b,c}.md` — commit shas, the
choices made, gotchas, gate results with test counts, "Flagged for user",
"To apply" (shared-file edits).
