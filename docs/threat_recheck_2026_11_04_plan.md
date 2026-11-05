# Threat recheck 2026-11-04 — fix plan

Gaps 74–104 of `docs/threat_model.md` ("Gaps found 2026-11-04"). Evidence, line
numbers (as of `b3abe5ba`) and each reviewer's suggested fix are in
`docs/threat_recheck_2026_11_04_handoff.md`. Scope chosen by the user on
2026-11-05: **all 31 gaps**, run with the plan → plan review → implementer and
reviewer batches → final review routine (at most five subagents). The decisions
below are fixed: reviewers may not undo them.

## Resume state

- 2026-11-05: decisions recorded (`9925a729`); steps and agent steps written.
- 2026-11-05: plan reviewed against the code (paths fixed, missed callers added,
  steps 2, 4, 6 and 7 split into two agent steps each; see "Open points decided by
  the plan review"). Next: the agent steps below.
- 2026-11-05: plan committed `6e36fd30`. Wave 1 running: I1, I2a, I3 in
  `.claude/worktrees/tr1104-<step>` (branches `tr1104/<step>`); reports go to
  `tmp/threat_recheck_2026_11_04/step-<step>.md`. Then: reviewers, I2b, I4a, I5, I6, …
- 2026-11-05: user: implementers from I2b on run on **Sonnet**; reviewers stay on Opus.
- **2026-11-05, paused by the user. To continue, do these in order:**
  1. **I2a** done: `tr1104/I2a` `41b78993` (gap 75), gates green except one flaky
     `api_proxy` port test (passed alone). Not yet reviewed.
  2. **I3** done: `tr1104/I3` `cb1f6f7f` (gaps 89, 90, 102–104), but its `gates.sh` was
     stopped halfway: run the `--no-default-features` clippy, the app-serverd
     clippy and tests, `cargo test --workspace` and the full vitest in its worktree
     first. Not yet reviewed.
  3. **I1** paused with two WIP commits on `tr1104/I1` (`2522ef52` gap 83,
     `1f8705db` gap 74 + export half of 86, docs and rows): not mergeable yet. A
     fresh Sonnet implementer in `.claude/worktrees/tr1104-I1` runs `cargo test -p
     tabtivity --test projects_commands an_imported_bundle` (never compiled yet),
     fixes it, runs `scripts/gates.sh` (`cargo test --workspace` and the daemon test
     never ran; 4 vitest files failed only under load), updates threat-model row 47
     (still says `copy_tree_core` has no guards), and rewords the two commits without
     "WIP". Details: `tmp/threat_recheck_2026_11_04/step-I1.md`.
  4. **I2b** never started: its worktree `.claude/worktrees/tr1104-I2b` (branch
     `tr1104/I2b` = `tr1104/I2a`) is ready. Start it on Sonnet.
  5. Then one Opus reviewer for I2a+I2b, one for I3 and one for I1, each followed by a
     merge into develop. After that: I4a, I4b, I5, I6, I6b, I7a, I7b, I8, I9, I10 as
     in the Agent steps table (at most 5 agents, 3 building), then the final review.
  Reports: `tmp/threat_recheck_2026_11_04/step-<step>.md` in the main checkout.
  Say "continue the threat recheck" to pick up here.
- 2026-11-05, resumed: running I1 (finish, Sonnet), I2b (Sonnet) and the I3 review
  (Opus, runs I3's missing gates first; report `review-I3.md`). Agents must never
  `pkill -f`: kill only their own PIDs.
- 2026-11-05: **I3 landed** on develop `f01652f9` (review `review-I3.md`: one gap-103
  bypass fixed, `5ac217bc`). I1 finished (`14fa850f`), its review running; I2b running.
- 2026-11-05: **I4a landed** on develop `60a408cf` (review fixed a gap-54 regression and
  the warm-up token attribution, `60bad0e4`). I1 reviewed (`b90d6747`, data-loss fix);
  its follow-up (copy cap decision, sandbox scope/network and `sync_code` resets,
  linear `pruned`, no-follow resume create) running, then land. I2a+I2b reviewed
  (`bc79d813`, revocation carried across re-imports); its follow-up (old-mail decision,
  `signature-structure` note) was mid-gates (uncommitted in `tr1104-I2b`), then land.
  I4b running on `60a408cf`. Next: I5, I6, then I6b, I7a, I7b, I8, I9, I10.

## Decisions (user, 2026-11-05)

| Gap | Decision |
|---|---|
| 74 bundle import | **Reset to defaults.** Import keeps only descriptive registry keys: `auto_connect` and `key_auth` stripped from the primary and every worker, the container imported off with `dockerfile`, `image` and `spec_source_hash` cleared (so enabling it runs the O#143 confirm), push and schedule levels reset to their defaults. The import report lists what was reset (as `vpnDropped` does). |
| 75 signed mail parts | **Show only the signed part.** A `multipart/signed` root needs exactly two children, the second signature-typed, or the verdict is Unusable (same in `encrypted_part_bytes`); when valid, the pane renders only children[0], never parts beside it. |
| 76 key re-import | **Drop Verified on change.** A re-import whose user-ID set differs from the stored one resets the key to unverified, and the import result says why. |
| 77 limit hand-off | **Never silent, quote the line.** Remove the "never ask" auto-switch; the dialog always asks and quotes the screen line that triggered it. |
| 78 Tabby `@` + web | **Strip URLs after an attachment.** Once a chat has an attachment, that tab's fetches lose query strings and fragments and URL paths are capped; the assistant home also denies the CLI reading the home's login files (check that `@` honours the deny). |
| 79 shell commands to the phone | **Restore the AGENTS.md rule.** Strip running-shell command lines again (bring back `empty_shell_commands`); the phone shows the description plus a "view in Terminal" link. |
| 80 hands-free voice picks | **No voice on permissions.** Voice never answers a dialog that grants a permission or saves a rule; other numbered questions show "Heard: N" and get the same chime-and-cancel window a dictated prompt has. Headset mode ignores a segment that began while the voice was reading (unless it is a barge-in). Desktop and phone. |
| 81 phone model/effort | **Per tab only.** The phone changes only the live tab (types `/model` into it); saved launch defaults are set on the desktop only. The phone's `PUT …/launch-defaults` route goes away. |
| 89 push card dismissal | **Ask the remote.** Confirm with `git ls-remote` (off the UI thread) before settling a card as already pushed; a dismissed card stays listed with its reason until cleared. |
| 91 imported private key bind | **Confirm, stay unverified.** Record whether a secret key was generated here or imported; binding an imported one asks a confirm that names the risk and leaves it unverified until the fingerprint is ticked. |
| 93 probes on the real `$HOME` | **Own home for probes.** `/usage`, `--version`, the warm-up and updates run with a Tabtivity agent home holding the stored login; Update refuses a CLI outside Tabtivity's install home and says so. |
| 99 tmux dim override | **Append, don't overwrite.** Append the override (or take a free index) once per tmux server; the phone rows say attaching sets a tmux option. |
| 103 branches that need a card | **main/master always.** The remote's default branch, `main`, `master` and any branch a release workflow triggers on always get a card at Apply. |
| — daily release check | **Add a switch, on by default** (Models & agents). Off: checks run only on a click. |
| 103 reading (2026-11-05) | **Named branches only.** Only workflow push triggers that name a literal branch or a literal-prefix pattern (`release/**`) add card-required branches; a bare `*`/`**` or no branch filter adds nothing. |
| 93 updates (2026-11-05) | **Keep the install home.** Updates keep `HOME` = the install home (`into_install_home`) plus the new refusal; the login-holding probe home is for `/usage`, `--version` and the warm-up. |
| 88 old mail (2026-11-05) | **Expired: keep; revoked: no.** A signature dated inside the key's validity still verifies after the key expires; a revoked key, subkey or (all) user IDs make every signature by it Unusable, whatever its date. |
| 83 copy cap (2026-11-05) | **Only on untrusted input.** The 200 000-entry / 32 GiB cap applies to bundle/set import and the host-copy export; the user's own archive, mirror move, Duplicate and move-out copies keep the FIFO/link/source guards but have no size cap. |

## No decision needed

The other gaps take the fix named in their threat-model row: 82, 83, 84, 85, 86,
87, 88, 90, 92, 94, 95, 96, 97, 98, 100, 101, 102, 104. Also from the recheck:
drop the three obsolete `zip` ignores (RUSTSEC-2026-0367/-0368/-0369) from
`.github/workflows/security.yml`.

## Rules for every step

- Each gap's evidence (file:line as of `b3abe5ba`), unverified points and the
  reviewer's fix are in `docs/threat_recheck_2026_11_04_handoff.md` under the report
  item the threat-model row names (e.g. gap 74 → C1 and D1). Line numbers drift:
  find the code by name.
- AGENTS.md binds: no app launch; `hardened_git_command_in` for git; i18n for every
  string (English holds every key); new UI gets an `UntestedTag` and a row in
  `src/lib/untested.ts`; new Tauri commands get a `command_class` row and the
  regenerated `commandClasses.ts`; cross-OS test paths; persisted JSON round-trips
  old shapes (a field added to a store defaults when absent).
- A fix that changes behaviour a threat-model row describes also updates that row:
  the gap row becomes "**Fixed, not live-verified.** Was (<sev>): … Now …" with what it
  leaves open, as the 2026-10-24 rows do. AGENTS.md changes only where a step says so.
- Every fix gets a regression test that fails without it (run the baseline in the
  worktree, never by stashing or swapping files in the shared checkout).
- Gates: `scripts/gates.sh` for what the step touches, zero new warnings.
- A fix that reads or writes a file an agent can write goes through `home_io`
  (`HomeFile`/`HomeDir`/`open_regular`/`read_record_capped`), never a bare `fs::*`.
- Report in `tmp/threat_recheck_2026_11_04/step-<N>.md` of the main checkout
  (absolute path; it is gitignored): commits, choices, gotchas, gates with test
  counts, "Flagged for user", and click-through steps for a live check.

## Steps

### 1. Bundle import and project copies (gaps 74, 83, 86 export half)
- 74: `commands/project_transfer.rs` `import_project_export_blocking` (the only
  import path: a set's member goes through it too via `ImportBundleRequest.member`;
  `finish_import` in `commands/projects.rs` is the folder/clone import and already
  has `strip_untrusted_project_fields`). Replace the drop-list (`drop_imported_openvpn`,
  `settle_imported_posture`, `drop_imported_confirmations`, `drop_mobile_keys`) with
  one pure `adopt_imported_entry(&mut Value) -> Vec<String>` (the notes), applied to
  **both** `entry_value` and `project_value` (the `project.json` twin; the code
  comment says it is read back):
  - Keep (registry `extra`): `directory`, `mirror`, `remote`, `compute_hosts`,
    `git_type`, `git_provider`, `git_profile_url`, `description`, `categories`,
    `color`, `icon`, `favorite`, `weight`, `created_at`, the time/stat fields the
    schema `Project` names, plus `sandbox` and `vm` handled below. Everything else is
    dropped, including keys a later build adds: an unknown key does not travel.
  - Strip `auto_connect` and `key_auth` from `remote` and every `compute_hosts`
    entry whether or not `openvpn` was there (keep the `openvpn` removal).
  - `sandbox`: keep only `enabled: false`, resource caps and `network` if it parses
    to a known value; clear `dockerfile`, `image`, `spec_source_hash`.
  - Reset `git_push_mcp` (level and protected list) and `schedule_mcp` to absent,
    drop `run_host`.
  - Also drop what Tabtivity later *executes* from the registry, which the decision's
    "descriptive keys only" already covers but the old drop-list missed:
    `python_interpreter` (Run/Debug executes it, and the path rewrite points it into
    the unpacked tree), `default_apps`, `agent_fence`, `remote_control`, `hpc`.
  - Notes (new strings next to `vpnDropped`: `connectReset`, `sandboxReset`,
    `pushReset`, `scheduleReset`, `interpreterReset`), keys `transfer.note.*` in all
    five dictionaries, shown by `ProjectImportBundleDialog.tsx` and
    `ProjectSetImportDialog.tsx`. A note appears only when something was reset.
  - Tests: unit tests on `adopt_imported_entry` with a crafted manifest (hostile
    `remote`, `compute_hosts`, `sandbox` with a matching hash, `python_interpreter`);
    change `bundles_carry_no_push_or_ci_confirmations` (the export keeps the level,
    the import resets it) and the `session_fields_never_ride…` expectation about
    `sandbox`; update `docs/context/project_transfer.md`.
- 83: `commands/projects.rs` `copy_tree_core` is shared by `move_tree`,
  `move_fresh_tree`, `copy_dir_all`. It must keep what `tree_copy` lacks (a
  destination that already exists for the resumed archive, `keep_git`, link
  replacement), so do **not** route it through `tree_copy::copy_tree`: harden it in
  place. Take the type from the `DirEntry` (lstat); copy only regular files, through
  `home_io::open_regular`-style handles (no-follow, non-blocking, regular on the
  handle); skip pipes, sockets and devices; add entry/byte/depth bounds with
  `tree_copy::{MAX_ENTRIES, MAX_BYTES}` and a depth of 128. A hit bound fails the copy
  before `move_tree`/`move_fresh_tree` reach `remove_dir_all(src)` (the source is
  never removed after a failed copy). Specials carry no data, so a move that skipped
  one still removes the source. `commands/remote_unpair.rs` `move_out_blocking` calls
  `move_tree`, so it is covered; add the regression test there too (a planted FIFO
  must not hang the move).
  Tests: `libc::mkfifo` in a tempdir (unix only, run the copy on a thread with a
  timeout), bounds through an injectable limits struct as `tree_copy` has.
- 86 (export half): `pack_host_tree`/`pack_tar` cap entries (200 000), bytes (32 GiB),
  the `links`, `carried` and `pruned` collections, and fail the export when a bound is
  hit (the half-written bundle is removed as other export errors do).
- Rows: gaps 74, 83, the export half of 86; tier-4 "Export / import" row (❌ → ✅/⚠️),
  "Run / terminal" note.

### 2. Mail signatures and key trust (gaps 75, 76, 88, 91), agent steps I2a and I2b
- 75 (I2a): `services/mail/mail_pgp.rs` `signed_part_bytes` and `encrypted_part_bytes`:
  exactly two children, the second `application/pgp-signature` (or
  `application/octet-stream` for encrypted), else `None` (Unusable). For a valid
  `multipart/signed` root, `commands/mail.rs` `apply_crypto_at` (the `PgpSigned` arm)
  returns the **signed part's own bytes** (children[0], the bytes `signed_part_bytes`
  already slices) as the new `raw`, as the decrypt arm does for its inner message.
  Every reader goes through `apply_crypto`, so this covers the pane (`body_inner`,
  also behind the root MCP's `mail_read`), `load_attachment` (~line 4649) and the
  second reader (~line 3413); the rendered text/HTML and the attachment list then
  come from children[0] only. `body_inner` also writes attachment rows
  (`put_attachment`) for a non-decrypted message: for a signed one it must not leave
  rows from an earlier whole-message open (replace them). Test first: a three-part
  signed mail through `mail-parser`, to see how it merges the third leaf (documented
  in the report); then a test that the narrowed bytes hold no unsigned part and a
  Bad/Unusable verdict never gets a Verified chip.
- 76 (I2b): `PgpKeyring::import` (both the secret and the public path): when a
  re-import's user-ID set differs from the stored entry's, store `verified: false`,
  and for a secret key also drop its `accounts` (the bind checked the IDs only at
  bind time; the user re-binds through the confirm of 91). The import result says why
  (a `reset` list on `PgpKeyInfo`/the result) and the Keys dialog shows it. Update the
  hardening-backlog bullet on re-imports.
- 88 (I2b): start with a spike on rpgp 0.20: what it exposes for key/subkey/user-ID
  revocation and key expiry (`details`, `revocation_signatures`, `key_expiration_time`).
  If revocation cannot be read, land expiry only and flag the rest. Revoked or
  expired keys leave `candidates_for`, `public_for_address` and `encrypt_to`'s subkey
  choice; a signature made after expiry or before key creation is Bad;
  `PgpKeyInfo` gains computed `revoked`/`expired` (not stored), shown in the Keys dialog.
  Fixtures are generated in the test with rpgp (expiry; a revocation certificate).
- 91 (I2b): `StoredKey` gains `origin` (`generated` | `imported`, `#[serde(default)]`,
  absent in old files). Set `generated` where the key is made here (the generate path,
  `StoredKey` literal near line 298) and `imported` in `import`. A re-import of a held
  fingerprint keeps the stored origin. Old entries without the field: a secret key
  counts as imported unless it already has `accounts`. `bind_account` for an imported
  secret key refuses unless the command carries `acknowledge_imported: true` (the
  confirm must be enforced in the backend, not only in the dialog), never sets
  Verified, and the answer says so; `MailKeysDialog.tsx` asks the confirm naming the
  risk. Check how the command's arguments reach the browser client/`core_dispatch`.
- Rows: gaps 75, 76, 88, 91, 71 residuals (g)/(h); "Mail message" row.

### 3. Agent push cards and the dev Todo view (gaps 89, 90, 102, 103, 104)
- 89: `services/mcp/git_push_mcp.rs` `settle_pushed_elsewhere`: confirm with one
  `ls_remote_raw` for `refs/heads/<branch>` (already `hardened_git_command_in`, hooks
  pinned off, bounded by `REMOTE_TIMEOUT`) before settling. It uses the **card's stored
  `url`**, never `remote.<name>.url` re-read from the agent-writable `.git/config`,
  skips a card whose `needs_url_confirm` is still true, and uses `creds()` (no token
  when `keyring_free()`: then the card stays pending). Settle only when the remote's
  tip equals the card's `head`, or `head` is an ancestor of it (local
  `merge-base --is-ancestor`, replace objects off). Any failure leaves the card
  pending. Call it only from the window's path (`commands/root_mcp.rs`
  `git_push_mcp_proposals`, already `blocking`); remove the call from `call_status`
  (the agent's own `git_push_status` poll would otherwise drive a network call per
  poll and has no token in the headless lane). Cache the answer per card (30 s) so
  repeated refreshes do not each dial. Dismissals that were not the user's (supersede,
  settle, the agent's withdraw) must stay visible: `Proposal` gains a
  `dismissed_by` (`user` | `system`) and `GitPushMcp.tsx` (its `shown` filter at line
  ~154 hides every `dismissed` row today) shows a system-dismissed card with its
  reason and a Clear button until cleared; a user dismissal still hides.
- 102: strip invisible and bidi characters from commit subjects with
  `root_mcp_mail::strip_invisible` (the helper the note uses); add a capped
  (e.g. 60) `--name-status --no-ext-diff --no-textconv` list with workflow, hook and
  manifest paths first, run through `lane_git_command`; a `to_default` card says how
  many files it touches. New fields on `Proposal` and its TS type; new strings.
- 103: `is_default_branch` (or the card rule in `must_stage`) treats the remote's
  default branch, `main`, `master` and the branches a release workflow of the pushed
  commit triggers on as needing a card at Apply. Read workflows from the committed
  blobs at `head` (`git ls-tree`/`cat-file` through `lane_git_command`, never the
  working tree), at most 20 files of 64 KiB, parsed with `serde_norway`. A "release
  workflow" is one whose `on.push.branches` lists a literal branch name or a pattern
  with a literal prefix (`release/**`); a bare `*`/`**` (CI on every branch) or no
  branch filter names nothing, or every push would need a card. The result only ever
  adds cards; `main`/`master`/default stay fixed. Parsing failures add nothing.
- 104: `decide` re-reads the proposal and checks Pending under the project lock;
  the status writes (`Running`, and the Dismiss branch, `decide_ci_repo`,
  `git_push_cancel`) become compare-and-set inside `update` (apply only while
  `status == Pending`); `fail()` never replaces `Pushed`. Test through the
  `BEFORE_TRANSPORT`-style seam or two threads: a second `decide` after the first
  `Pushed` leaves `Pushed`.
- 90: `services/dev_todo.rs` `list_in`, `read_in` **and `write_in`'s read** (it also
  uses `fs::read_to_string`): read through `home_io::HomeFile::open_below` (no
  link on the way, non-blocking, regular on the handle) with a 4 MiB cap.
- Rows: gaps 89, 90, 102–104; "Agent push / release / CI" row.

### 4. Agent CLIs (gaps 93; 77, 95, release-check switch), agent steps I4a and I4b
- 93 (I4a): give `agent_usage` (`claude -p /usage`), `probe_agent_version`
  (`services/agent/agent_registry.rs`), the warm-up (`agent_warmup`, `commands/agents.rs`)
  a Tabtivity agent home of their own: a new `agent_home::probe_home_in`/`probe_home`
  with the key `probe.cli` (a `project_key` never holds a dot, so no project, box or
  imported id can name it, and it must not end in `.local`), a `Seed::Probe` in
  `prepare_home_with` that places only the shared logins (`agent_auth`) and what a
  first print-mode run needs (onboarding/trust for the `agent-cron` cwd): no
  `agent_global` layer, no session hooks, no transcript seeding. Never mounted into a
  fence (check nothing enumerates `agent-homes/` for mounts). Set `HOME` (and on
  Windows `USERPROFILE`/`APPDATA` as `install_env_for` does) on those commands.
  `agent_home::existing_homes_in` already lists every folder under `agent-homes`, so
  the keeper adopts a token rotation a probe run caused (otherwise the stored login
  would go stale): pin that with a test; any orphan-home sweep or
  `delete_scope_home` must not take the probe home. `update_command` refuses a resolved binary outside
  `agent_install::install_root()` with a clear message (no `agy update` on a host
  copy). Note: `update_command` already runs with `HOME` = the install home
  (`into_install_home`), not the user's; keep that (an update needs no login), so the
  decision's "updates run with a Tabtivity home" is met by the install home plus the
  refusal. Tests: the probe home path never collides with `scope_home`/`host_home`/
  `is_local_model_home`; a probe command carries the probe `HOME`; the keeper sees it.
- 77 (I4b): `TerminalLimitHandoff.tsx`: remove the remembered "never ask"
  (`agent_limit_auto_handoff`): the auto branch, the `neverAsk` checkbox and the
  `remember` argument, the checkbox in `AgentsPanel.tsx`, the field in
  `types/index.ts`, the i18n keys; an old `true` in settings is ignored. The dialog
  always asks and quotes the screen line that matched (add a line-returning variant
  of `hasCliLimitNotice` in `lib/agents/limitHandoff.ts`; the line is stripped of
  ANSI, control and bidi characters and cut at 160 characters). Rewrite
  `TerminalLimitHandoff.test.tsx` (it mocks the old setting). Only the desktop reads
  the screen for this (`TerminalView.tsx`); the phone has no hand-off.
- Release-check switch (I4b): setting `daily_release_check` (default on, absent =
  on; a `Settings` getter like `daily_stats_recap()`) in Models & agents; read on
  every tick of `start_daily_update_check`/`run_daily_update_check` (CLIs and
  `ollama::daily_release_check`), so a change applies without a restart; off means
  neither runs and checks happen only on a click.
- 95 (I4b): `services/agent/model_rows.rs`: rows are kept per scope: the `Entry`
  gains a map scope id → `Rows` (`#[serde(default)]`); the old unscoped `rows` are no
  longer read by any sheet (they are the ones a fake picker could have planted);
  `screens` (Tabby's probe) stays apart; the scope count is capped. Both writers and
  readers take the scope: desktop `remember_model_rows`/`remembered_model_rows` and
  `useSessionPicker.ts:330` (the tab's project id), the phone's
  `remember_model_rows`/`model_rows` handlers in `mobile_control/host.rs` (the tab's
  scope), Tabby's chip. Check `core_dispatch.rs` for the argument shape.
- Rows: gaps 77, 93, 95; tier-0 "Background release check", tier-3 "Usage-limit
  hand-off", "Scheduled agent prompts / warm-up cron", "Update CLI".

### 5. Tabby attachments, home readers, OpenCode identity (gaps 78, 92, 94)
- 78: `services/mcp/web_lane.rs` + `services/agent/assistant.rs`: once a Tabby chat
  has had an `@` attachment, that tab's `web_fetch` URLs lose query string and
  fragment and the path is capped (64 bytes, stated in the tool description and the
  Tabby row), `web_search` queries are capped (128 characters). "Had an attachment" is
  decided by the backend, not the renderer: set when the PTY input path sees the user's
  own keystrokes carry an `@` mention (the PTY input path in `commands/terminal.rs`
  next to `pty_input_from`) or when a file lands in the chat via
  `pty_drop_files`/`mobile_control/host.rs` `drop_box`; stored in the state dir keyed
  by the chat's uid (not in the chat folder, which the fence mounts rw), so it
  survives a restart and a resume; the lane reads it by `session.identity.tab`.
  The row states the residual: host-name labels and path segments still carry up to
  the cap, so this limits the leak's size, it does not close it. Add a
  `permissions.deny` for `Read` of every login file (generated from the registry's
  auth paths, `~/`-relative) to the assistant home's Claude settings and test whether
  `@` honours it, outside the app against the installed `claude` (unset both tab-uid
  variables, `tmp/verify-harness`); record the answer or "unverified" in the row.
- 92: `services/agent/agent_features.rs`: read through `home_io::HomeFile` with a
  size cap and deadline; list skills with `HomeDir::names()` capped (a few hundred).
- 94: `services/agent/agent_auth.rs` `opencode_adoption`: for an `oauth` entry, derive
  an identity from the **stored** entry's `access` token (the JWT `sub`/account claim,
  decoded, no signature) and refuse a rotation whose new `access` carries a different
  or no identity when the stored one has one. No hash of the refresh token: it rotates
  with every refresh, so it cannot be an identity. A stored token with no claim
  (opaque, a `gho_` token) keeps today's behaviour. State in the gap 94 row that an
  unsigned claim is forgeable by an agent that reads its own home's copy, so this
  stops accounts mixing up and a lazy swap, not a determined agent; the strong fix
  (refresh only in the keeper) stays open.
- Rows: gaps 78, 92, 94; the Tabby row.

### 6. Phone I (gaps 79, 81, 82; 98, 99), agent steps I6 and I6b
- 79 (I6): `services/mobile_control/host.rs` `phone_transcript`: bring back
  `empty_shell_commands` (see `git show c6fadf19`; test in `host/tests.rs`) and in
  `mobile-web` `components/RunningShells.tsx`/`api.ts` and
  `src/__tests__/mobile/MobileRunningShells.test.tsx` show the shell's description
  plus a "view in Terminal" link instead of the command (new string, five
  dictionaries). Also update the "Phone analysis" text that says commands cross.
- 81 (I6): remove the `PUT …/launch-defaults` route and `save_launch_defaults`, and
  with them the only reader, the `GET` route and `launch_defaults_cli`, plus
  `mobile-web` `components/LaunchDefaultsFold.tsx` and its two `api.ts` functions; the
  phone's model/effort sheet acts on the live tab only (types `/model`, as
  `useModelPicker.ts` already does). The desktop keeps `agent_defaults::save_in`. An
  old cached PWA calling the route gets the router's 404/405, which its fold shows as
  a failed save, not a crash. Retire the `mobile.model.launchDefaults` untested id.
- 82 (I6): `mobile-web/src/forgetDeviceData.ts` also clears the slash-command history
  (`slashCommands.ts`: add `forgetSlashCommands()`); test it with the unpaired path.
- 98 (I6b): `services/mobile_control/files_zip.rs`: skip entries whose name holds `\`,
  a control character, or starts with `-`/`~`, and count them in the answer (the
  phone says how many were left out).
- 99 (I6b): `pty_bridge.rs` `tmux_keep_dim_command` / `services/remote/ssh_exec.rs`
  `host_tmux_keep_dim_command`: first `show-options -sv terminal-overrides`, and only
  when no `vt100:dim=` entry is there append it with `set-option -sa` (never set
  index 77). tmux made the option an array in a later release than the old HPC tmux
  the file already handles (`HOST_TMUX_EXACT`): the implementer checks the changelog
  and appends with a leading comma on the string-typed versions. Unit-test both
  command builders (the strings are pinned near `pty_bridge.rs:1372`); a real-tmux
  test on a private `-L` socket, gated by a `have_tmux` check. The phone rows say
  attaching sets a tmux server option.
- Rows: gaps 79, 81, 82, 98, 99; phone tier rows ("Phone bridge", model sheet row).

### 7. Phone II: upload budget and Diverged resolve (gaps 96, 97), agent steps I7a and I7b
Both run after I6 is landed (all three edit `host.rs`; different regions).
- 96 (I7a): `uploads.rs` gets an in-memory reservation per project: reserve the
  declared `Content-Length` (the whole `MAX_UPLOAD_FILE` when none is declared) against
  the day's remaining budget before `stage_body`, refuse with the existing
  `Full` error when it does not fit, release when `store_staged` finishes or
  fails, so stagings in flight count. Cap stagings in flight (4 per project, 8 in
  all). New folder gets a per-project daily count cap (200) and a record in the upload
  log (kind `folder`, size 0; old logs must still read). `host.rs`
  `project_files_upload`/`project_files_folder` call them.
- 97 (I7b): `diverged_preview` also accepts the delete ops and returns, besides the
  facts, a `token`: an HMAC with the sidecar's host key over (project, op, sorted file
  tokens, the window's fingerprint of those rows' state and mtimes, a 10-minute
  expiry). Every op except `forget` needs it in `resolve`, and the sidecar passes the
  fingerprint to the window (`DesktopRequest::SyncResolve` gains `expect`), where
  `mobileDiverged.ts` `divergedResolve` recomputes it from the fresh status next to
  `stillStands` and refuses on a mismatch (the `remote_unpair` pattern). The window's
  dispatch in `MobileBridgeHost.tsx` repeats the `project_sync` check. The phone
  (`mobile-web` Diverged screen) calls preview before every destructive resolve and
  echoes the token. `careful_hosts`/`hpc_hosts`: a resolve that would dial or delete
  on such a host is refused with a `careful_host` answer (mirror
  `lib/remote/carefulHost.ts`, which the orange view uses); `local_loss` is recorded
  by the commands `resolveAll`/`applyDeleteAll` call (`commands/sync.rs`, ~1333 and
  ~1963): add a test that a phone-driven delete and overwrite reach it.
- Rows: gaps 96, 97; "Phone: Diverged list and resolve", "Phone project files".

### 8. Voice (gaps 80, 101)
- 80: add `voicePickable(prompt)` beside `voicePick` in `mobile-web/src/handsFree.ts`
  (shared by both callers): true only for a dialog that is a *question*, i.e. the
  parsed prompt carries step `navigation` (Claude's question tabs, OpenCode's) or a
  free-text row; a permission dialog ("Do you want to proceed?", Yes / don't ask
  again / No), an unrecognised shape and any CLI the parser cannot classify are
  refused. The parser has no "kind" today, so this is the new rule; say in the row
  that a screen-drawn fake dialog can still look like a question (the screen is the
  agent's), which is why the pick also goes through the chime-and-cancel window.
  Callers: `TerminalReaderView.tsx` `pickByVoice` and the phone
  `screens/terminal/useHandsFree.ts` (`voicePickRef`) show "Heard: N" and send the
  pick through the same `createSendGuard` window a dictated prompt gets; the pick is
  not typed until the window closes. `services/voice/session.rs`: in Headset mode drop
  a segment that began while `GATE.speaking()` unless it opened a barge-in. Tests:
  `voicePickable` on captured dialogs (a permission dialog, a question, a Codex
  picker); the guard with a fake clock.
- 101: `services/voice/ssip.rs` `spawn_server`: resolve `speech-dispatcher` with
  `paths::system_executable` (not `PATH`); it forks and the child exits, so register
  the server through its own pid file (`--pid-file <state_dir>/…`, check
  `speech-dispatcher --help` first) and stop it at the quit teardown only when this
  run started it (read the pid, check `proc_table::start_time` and the owner, SIGTERM).
  If the installed version has no pid-file option, leave starting it to socket
  activation and answer `no-speech-server`.
- Rows: gaps 80, 101; "Desktop dictation and read-aloud", phone voice row, gap 69 note.

### 9. Remote reads and the ssh probe (gaps 84, 85, 86 pull half)
- 84: `services/remote/sftp.rs`: a bounded `read_file_up_to(sftp, path, limit)`.
  Callers to move over: `remote_transcript.rs` (the transcript copy at ~255 and the
  `environ`/`sessions` reads at ~411–417), `agent_host_move.rs` (~314, ~335, ~384),
  plus the other host-sized reads the audit finds: `commands/sync.rs` (~161, ~1208 the
  "identical" check, ~1904 `sync_diff`), `commands/hpc_ws.rs` (~902), `commands/fs.rs`
  `remote_read` (~696; the user's own file read keeps its cap choice, say which).
  A total byte budget per move in `agent_host_move.rs`.
- 85: `commands/ssh.rs` `ssh_unreachable`/`probe_verdict`: the probe adds
  `-o LogLevel=ERROR`, which keeps a server's pre-auth banner out of stderr (OpenSSH
  prints it only at INFO and above; verify against a local `sshd -o Banner=` or the
  source, and if it still shows, fall back to line-anchored client prefixes). Then
  classify from the exit code plus lines that start with a client prefix
  (`ssh: connect to host`, `ssh: Could not resolve hostname`, `Connection closed by`,
  `Connection reset by`, `kex_exchange_identification:`) instead of substrings of the
  whole text; keep the raw-stderr regression cases the earlier fix added. Test with a
  stderr that carries a banner line "Connection closed by".
- 86 (pull half): before a manual pull, check free space against the preview's total
  (the statvfs read already in `duscan.rs` and `vm.rs`; share one helper) and refuse with a clear
  message; the file and folder pull arms of `commands/sync.rs`.
- Rows: gaps 84, 85, the pull half of 86; byte-sync row.

### 10. Desktop odds and ends (gaps 87, 100, cargo-audit ignores)
- 87: `services/window_registry.rs` `TrackedWindow` gains `pid_start: Option<u64>`
  (`#[serde(default)]`), set wherever `pid` is set (row creation in `commands/apps.rs`
  ~124 and ~2458, `commands/subwindow.rs` ~451, the family move ~369/~2404 and the
  demotion to 0); `close_tracked_window` refuses when `proc_table::start_time(pid)`
  no longer matches. `start_time` is Linux-only (`None` elsewhere): on Linux a row
  without a start is refused with "the app is no longer tracked"; on macOS and Windows
  keep today's behaviour and say so in the row.
- 100: `platform/workspace_settings.rs` `restore_ops`/`take_over`: restoring drops any
  record whose (schema, key) is not in the union of the desktop tables (a leftover file
  is restored without knowing the desktop) or whose value has the wrong type; call
  `gsettings` by `paths::system_executable("gsettings")` in `platform/x11.rs`
  `gsettings_run` and `commands/os_clock.rs` `gsettings_get`.
- Drop RUSTSEC-2026-0367/-0368/-0369 from `.github/workflows/security.yml` (the
  `cargo audit` line and the comment above it); `Cargo.lock` holds only `zip` 9.0.5,
  checked; update the hardening backlog.
- Rows: gaps 87, 100; hardening backlog.

## Open points decided by the plan review

- 74: an allowlist of descriptive registry keys; `python_interpreter`, `default_apps`,
  `agent_fence`, `remote_control`, `hpc` also dropped (the old drop-list missed the
  interpreter, which Run executes); applied to the registry entry and the `project.json`
  twin; a note per reset.
- 83: `copy_tree_core` is hardened in place, not routed through `tree_copy`, which
  cannot resume into an existing destination or skip `.git`; a hit bound never removes
  the source.
- 75: a valid signed mail renders children[0]'s own bytes (the way a decrypted inner
  message is rendered), so body, attachments, `load_attachment` and `mail_read` agree.
- 76: a changed user-ID set also drops a secret key's account bindings.
- 91: the confirm is enforced in the backend (`acknowledge_imported`), not only in the
  dialog; unknown origin of an old secret key counts as imported unless bound.
- 88: expiry lands in any case; revocation lands if rpgp 0.20 exposes it, else flagged.
- 89: the `ls-remote` runs only from the window's refresh, with the card's stored URL,
  never from the agent's `git_push_status`; no token or any failure leaves the card
  pending. Non-user dismissals stay visible until cleared.
- 103: only literal or literal-prefix branch patterns of a workflow's push trigger count
  as "release" branches; `**`-style CI-on-everything never forces a card.
- 90: `write_in`'s read is hardened too.
- 93: the probe home is `agent-homes/probe.cli`, seeded with logins only (no global
  layer, no hooks); updates keep `HOME` = the install home they already run with.
- 95: the unscoped `rows` already on disk are never shown again.
- 77: the quoted screen line is cleaned and cut at 160 characters; the Settings
  checkbox goes with the remembered choice.
- 78: attachments are detected from the user's input path and the drop paths, stored
  outside the chat folder; the residual (host-name labels and path segments) is stated.
- 94: identity comes from the stored entry's access-token claim, not a refresh-token
  hash (it rotates); an unsigned claim is forgeable by an agent that reads its own copy.
- 81: the fold and both launch-defaults routes go, not only the `PUT`.
- 99: detect-then-append, one `show-options` per attach, no marker state.
- 96: reservation by declared length; cap of 4 stagings per project, 8 in all; 200
  folders per day per project.
- 97: the token is an HMAC of the window's fingerprint; every op but `forget` needs it;
  a careful/HPC host refuses a phone-driven delete.
- 80: a voice pick needs a positively recognised question dialog; an unrecognised shape
  is refused.
- 101: the pid file route, else no-speech-server.
- 85: `LogLevel=ERROR` on the probe, then client-prefix lines only.
- 87: the check is Linux-only; other systems keep today's behaviour and the row says so.
- 100: the allowlist is the union of the desktop tables.

## Organisation

Security work over mostly disjoint subsystems: one implementer per agent step in its
own worktree (`.claude/worktrees/tr1104-<id>`, `node_modules` hardlinked, own
`CARGO_TARGET_DIR` inside the worktree), then, for the risky steps, an independent
reviewer with no shared context who fixes confirmed bugs only (with a regression
test) and flags the rest. Steps I4b, I6b, I8 and I10 are lower risk and are covered
by the final review. At most five subagents at once and at most three building at
once. The main agent merges each reviewed step into develop itself, in order.

Dependencies and shared files:
- I2b starts after I2a is landed (both edit `mail_pgp.rs`); I4b after I4a (both edit `commands/agents.rs`); I7a and I7b after I6
  (all edit `mobile_control/host.rs`; I7a and I7b touch different handlers).
- `mobile_control/host.rs` is also edited by I4b (model-rows handlers) and I5 (the
  `drop_box` hook): small, separate regions; merge in the order I4b, I5, I6, I7a, I7b
  and have each implementer rebase onto develop before reporting.
- The five i18n dictionaries, `src/lib/untested.ts`, `docs/threat_model.md` and the
  file maps are touched by most steps: every implementer adds its keys and rows as one
  block, rebases onto develop before the last gate run, and edits only its own rows.
- I3 and I10 touch no shared Rust file with another step; I1 touches `projects.rs`
  and `remote_unpair.rs` only.

## Agent steps

| Agent step | Plan step | Main files | Reviewer |
|---|---|---|---|
| I1 | 1 | `commands/project_transfer.rs`, `commands/projects.rs`, `commands/remote_unpair.rs`, the two import dialogs | yes |
| I2a | 2 (75) | `services/mail/mail_pgp.rs` (part functions), `commands/mail.rs` (`apply_crypto_at`, `body_inner`) | yes (with I2b) |
| I2b | 2 (76, 88, 91), after I2a | `services/mail/mail_pgp.rs` (keyring), `MailKeysDialog.tsx`, `PgpKeyInfo` types | yes (with I2a) |
| I3 | 3 | `services/mcp/git_push_mcp.rs`, `commands/root_mcp.rs`, `GitPushMcp.tsx`, `services/dev_todo.rs` | yes |
| I4a | 4 (93) | `agent_home.rs`, `agent_registry.rs`, `agent_auth.rs` (keeper), `commands/agents.rs` (usage, warm-up, update) | yes |
| I4b | 4 (77, switch, 95), after I4a | `TerminalLimitHandoff.tsx`, `AgentsPanel.tsx`, settings schema, `commands/agents.rs` (daily loop, model rows), `model_rows.rs`, `useSessionPicker.ts`, `host.rs` model-rows handlers | final review |
| I5 | 5 | `web_lane.rs`, `assistant.rs`, `commands/terminal.rs`, `agent_features.rs`, `agent_auth.rs` (OpenCode) | yes |
| I6 | 6 (79, 81, 82) | `mobile_control/host.rs`, `mobile-web` (`RunningShells`, `LaunchDefaultsFold`, `forgetDeviceData`) | yes |
| I6b | 6 (98, 99) | `files_zip.rs`, `pty_bridge.rs`, `ssh_exec.rs` | final review |
| I7a | 7 (96), after I6 | `mobile_control/host.rs` (upload handlers), `uploads.rs` | yes (with I7b) |
| I7b | 7 (97), after I6 | `mobile_control/host.rs` (diverged handlers), `protocol.rs`, `MobileBridgeHost.tsx`, `mobileDiverged.ts`, `mobile-web` Diverged screen | yes (with I7a) |
| I8 | 8 | `shared/handsFree.ts`, `mobile-web/src/handsFree.ts`, `TerminalReaderView.tsx`, `useHandsFree.ts`, `voice/session.rs`, `ssip.rs` | final review |
| I9 | 9 | `remote/sftp.rs`, `remote_transcript.rs`, `agent_host_move.rs`, `commands/ssh.rs`, `commands/sync.rs`, `remote_sync.rs` | yes |
| I10 | 10 | `window_registry.rs`, `commands/apps.rs`, `commands/subwindow.rs`, `workspace_settings.rs`, `x11.rs`, `os_clock.rs`, `security.yml` | final review |

Fourteen agent steps, eight step reviewers (I2a/I2b and I7a/I7b share one each), one
plan reviewer, one final reviewer.
