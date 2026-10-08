# Threat recheck 2026-10-08 fixes — handoff

Plan: [`docs/threat_recheck_2026_10_08_plan.md`](threat_recheck_2026_10_08_plan.md)
("Run 2026-10-08" section). Branch `threat/1008`, worktree
`.claude/worktrees/threat1008`. Each implementer and reviewer appends a short
section: commits (shas), files, tests added, gates with results and test
counts, choices made, gotchas, and "Flagged for user".

## Agent step 1 — implementer (gap 16, A1 per-scope)

**Commit:** `6b0e0649` Stop sharing dotenv and config files as agent logins.

**Files:** `src-tauri/src/commands/agents.rs` (Cline, Vibe, aider,
mini-swe-agent `auth_paths: &[]`; `auth_paths` doc comment; CodeBuddy/Kimi
rows name their `DirNames`), `src-tauri/src/services/agent_auth.rs`
(`AuthKind::Dir(DirNames)`, `DirNames::{Json, CodeBuddyInfo}::admits`,
allowlist in `reconcile_dir`, `status_in` signed-in and importable,
`remove_copies`, import's one-level `copy_dir_logins` replacing the recursive
`copy_dir`; `RETIRED` + `retire_shared_paths_in`/`retire_dir_names`; module
docs), `src-tauri/src/lib.rs` (`retire_shared_paths()` before
`import_once`), `services/agent_home.rs` (stale "hard-linked" prose),
`commands/ollama.rs` (comment), English + de/es/fr/it
`settings.agentLoginsHelp`, `docs/help/agent-clis.md` (Sign in + API-key
paragraph), `docs/context/agent_authority.md` (item 4 + "One login per
CLI"), `docs/filemap_backend.md` (`agent_auth.rs` row),
`docs/third_party_update_checklist.md`, `docs/threat_model.md` row 16
(**Fixed, not live-verified.** with the residual).

**Tests added** (`agent_auth.rs`): `no_registry_row_shares_an_env_or_config_file`,
`retiring_a_shared_path_keeps_scope_copies_and_clears_the_hosts` (store dir
gone; fenced and `.local` copies kept; Host copy equal to the store removed,
Host copy equal to its `.placed` record removed, divergent Host copy kept; a
later scope write no longer spreads; second run a no-op),
`retiring_drops_unlisted_names_from_login_folders`,
`a_login_directory_shares_only_allowlisted_names` (Kimi temp + `x.env`,
CodeBuddy backup + `.logged-out` neither adopted nor placed, nor counted as
signed in), `dir_names_admit_only_the_login_file_shapes`,
`import_copies_only_allowlisted_names_of_a_login_folder`. Updated:
`a_local_model_home_receives_logins_but_never_feeds_them_back` now uses
`.codex/auth.json`; `a_login_directory_is_reconciled_file_by_file` uses
`kimi-code.json`.

**Gates (at `6b0e0649`):** `npm run build` ok; `npm test` 735 files / 7555
tests passed; `cargo test` 3733 passed, 3 ignored, 0 failed (lib 3565 +
integration); `npm run lint` 0 errors, 28 advisory warnings (none in touched
files; no TS logic changed); `cargo clippy --all-targets -D warnings` clean;
`scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh` clean. `npm run backend:stale` not run (main
agent at landing).

**Choices:**
- The allowlist is an enum (`DirNames`) on `AuthKind::Dir`, not a fn pointer,
  so `AuthPath` keeps its derives without fn-pointer comparisons.
- `retire_shared_paths_in` keys on the retired CLI's store dir existing (no
  marker). If removing the Host copy fails, the store dir is kept so the
  next start can still tell Tabtivity's copy from the Host session's own.
- The Host-copy check compares the raw file digest with the store file's
  digest and with `.placed/host/<leaf>`.
- Folder cleanup removes a home's unlisted name only where its digest equals
  that home's placed record, then deletes the unlisted store files and their
  `.placed/*/<leaf>_<name>` records in every record dir.
- `status_in.importable` for a login folder now means "holds an admitted
  file", so an import of a folder with only strays reports the existing
  "no login file" error instead of copying nothing.
- No `UntestedTag`: no new UI; Settings drops the four CLIs from the
  shared-login list by `LoginStatus.shared` alone.
- Test fixtures use neutral `VIBE_FIXTURE`/`AIDER_FIXTURE` names, not API-key variable names, which
  the privacy check flags.

**Gotchas:** the first cargo build in this worktree took over 10 minutes; a
foreground `timeout 590` run printed nothing. Run cargo in the background.

**Flagged for user:**
- Vibe, Aider, mini-swe-agent and Cline now sign in once per project. Existing
  project homes keep the login they had; the Host session loses a copy
  Tabtivity put there. One key everywhere: put the file into the global agent
  config (Settings → Agent sandbox → Global agent config → Open folder).
- Residual (row 16): content planted before the fix stays in the fenced homes
  it reached; Goose `secrets.yaml`, OpenCode `auth.json`, Qoder `.auth` are
  still shared on the 2026-09-25 survey, not re-surveyed.
- Not live-verified; the allowlists are read off CodeBuddy 2.162.0 and Kimi
  Code 2.1.1 bundles. A newer CLI that renames its login file would stop
  being shared (fails safe: it signs in per project).

## Agent step 1 — reviewer

Reviewed `0ac7eaf9..5200f442` (`6b0e0649`, `5200f442`) against the gap 16
row, Steps row 1, the fixed decisions and the agent step 1 review notes.
**No code change; no confirmed bug.**

**Checked and fine:**
- No env/config file left in the registry: Cline, Vibe, aider and
  mini-swe-agent rows are `&[]`; the remaining shared files are the
  credential files the plan lists. Nothing else writes into
  `agent-auth/<cli>/` for them (only `import_from_user_home_in` creates an
  empty store dir on a direct invoke, which returns an error, and the next
  start's retire removes it). No other module copies those paths into a home
  (`agent_global` copies only the user's layer).
- Allowlist: `DirNames::admits` refuses empty names, leading dots (so `.`,
  `..`, `..json`), `/` and `\`. Upper-case or Windows-mangled names fail
  closed. Every home read and write goes through `home_io` handles
  (`O_NOFOLLOW`, regular file only on read), so a symlink, FIFO or directory
  named `x.json` is neither adopted nor followed. Store-side listings keep
  regular files only.
- Applied in `reconcile_dir` (adopt and place), `status_in` (signed in and
  importable), `remove_copies` (sign-out and import) and the one-level
  `copy_dir_logins`. `import_once` skips the four CLIs (`shared: false`), and
  Settings and the phone bridge filter on `shared`.
- Retire: runs once per start, synchronously in setup before `import_once`
  and the keeper (`lib.rs:1303`), which are the only entry points, so it
  cannot race the keeper. It is idempotent: the store dirs are gone after
  the first run, the folder records for unlisted names are gone, and no code
  path writes either again. Store keys come from `store_dir_in`/`leaf_of`
  like the keeper's, and the `host` record key matches `home_key`. If the
  Host copy cannot be removed, the store is kept for the next start. The
  Host session has no `.local` home (`launch_prep` always uses
  `prepare_host_home`). On Windows every scope home is already unfenced, so
  the copies kept there add nothing.
- Tests fail on the old code for the right reason (`x.env` and the temp were
  adopted before; the retired rows were in the registry). The rewritten
  local-model test still covers receive-only on a remaining shared file.
- i18n: `settings.agentLoginsHelp` changed in en/de/es/fr/it, the only
  dictionaries. Docs (`agent_authority.md`, `help/agent-clis.md`,
  `threat_model.md` row 16, file map, checklist) match the code. The
  remaining mentions of the old paths are plan or history prose.

**Gates (at `5200f442`, nothing changed):** `cargo test -q` 3733 passed,
3 ignored, 0 failed (`--lib agent_` subset 359 passed);
`cargo clippy --all-targets -D warnings` clean. The npm gates were not rerun
(no TS changed since the implementer's run).

**Flagged for user:**
- The Host cleanup also removes a Host-session login that the keeper had
  adopted into the store. An adopted copy and a placed copy leave the same
  record (`.placed/host/<leaf>` = digest), so the code cannot tell a Vibe,
  Aider, mini-swe-agent or Cline login made in the Host session from one
  Tabtivity put there. That file goes, including any other settings the
  user had added to it. This is the plan's chosen rule, and it is the safe
  side. The implementer's note "the Host session loses a copy Tabtivity put
  there" understates it: after the first start, sign in to those CLIs again
  in the Host session. If keeping such a file matters, rename it aside
  (for example to `<file>.tabtivity-retired`) instead of deleting it. That
  is a design change, not made here.
- The same applies, on a small scale, to the folder cleanup: a CodeBuddy
  `.logged-out` marker or logout backup in the home that wrote it has a
  matching placed record (from its adoption) and is removed there too.
- Sign out now removes only allowlisted names. A CodeBuddy logout backup
  (`<stem>.<time>.<pid>.<uuid>.info`, which holds the old token) or a
  leftover Kimi temp file stays in the home whose CLI wrote it. These files
  are that scope's own and are not shared. Earlier, Sign out wiped the whole
  folder in every home.
- Dead data: an import by the old recursive `copy_dir` could leave
  subdirectories in `agent-auth/{kimi,codebuddy}/<leaf>/`. Those were never
  placed and still are not, and the retire does not remove them (it only
  removes regular files).
