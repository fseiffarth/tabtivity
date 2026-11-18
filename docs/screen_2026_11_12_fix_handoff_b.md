# Screen 2026-11-12 — handoff B (untrusted input → host)

Branch `worktree-agent-a69fd7785e5bb7c54`, based on develop `214933ab5`.
Items H3 (+ bundle `state/` filter), H4, H5, H6, H8 of
`docs/screen_2026_11_12_fix_plan.md`. Never run live.

## Commits

| sha | item | what |
|---|---|---|
| `e255432b8` | H3 + Medium | `extract_section` skips a link whose folder (import root → link parent) is a link; remote `state/` keeps only `REMOTE_STATE_FILES` (regular top-level files) |
| `7a39f2ce4` | H4 + H8 | `fetch_local` passes the `GitHooks` exec_trust gate; fingerprint also covers `url.*.insteadOf`/`pushInsteadOf`; both Fetch buttons use `invokeTrusted`. Poetry probe only for a folder `exec_trust::approved_for` says yes to |
| `afb4f99e5` | H5 | box agent docs: `symlink_metadata` check, capped no-follow read, `write_no_follow`; a link/non-regular/unreadable doc is skipped and logged |
| `94f798acc` | H6 | `ssh_trust_host_key(host, port, fingerprints)`: re-scans, writes only plain lines for the exact resolved host field whose SHA256 fingerprint was shown; now async; preview drops `scan`; frontend store updated |

## Choices made

- **H3.** Ancestor walk (`linked_ancestor`) with `symlink_metadata`, stopping
  at the first missing component (below it `create_dir_all` makes plain
  folders). The walk runs before `create_dir_all`, so a linked parent is never
  followed even to create folders. A skipped link is reported with
  `eprintln!`, the same as the Windows "missing link" gap; there is no
  report field for it today. `extract_section` gained an `only:
  Option<&[&str]>` allowlist; only the remote `state/` call passes one.
- **H4.** Called `exec_trust::require(GitHooks, dir)` directly in
  `fetch_local`, as `push_local` does, so it covers the worktree path, the
  local project path and the lockstep-mirror path (the mirror can come from
  an imported bundle, `.git` included). The fingerprint already held
  `core.sshCommand`, `credential*.helper`, `remote.*.uploadpack` and
  `core.gitProxy`. Added `url.*.insteadOf` / `url.*.pushInsteadOf`. The
  host-side remote fetch (`run_git` over ssh) is unchanged, like
  `require_hook_trust` skips remote targets.
- **H8.** exec_trust has no Poetry kind and the plan says no new prompt, so
  "a project exec_trust has approved" became the new
  `exec_trust::approved_for(dir)`: some kind has a stored approval for this
  exact folder that still matches its current fingerprint. It never prompts
  and never writes. It reads the store once and collects only kinds that
  have an entry. The seam `poetry_env_if` makes the gate unit-testable.
- **H5.** Read cap is 4 MB (`MAX_BOX_DOC_BYTES`). A missing doc is created
  with `create_new` (O_EXCL), an existing one is truncated through the
  no-follow handle. A real write error still propagates as before.
- **H6.** Fingerprints are computed in Rust (`SHA256:` + unpadded base64 of
  the key blob, the form `ssh-keygen -l` prints) instead of zipping keyscan
  lines with `ssh-keygen` output by position. A kept line is rebuilt from
  three tokens, so comments are dropped. The key's embedded type must equal
  the line's type. Allowed host field: exactly `known_hosts_key(resolved,
  port)`. A field containing `* ? ! , @ |` is never accepted. If the host no
  longer offers a shown key, nothing is written and an English error says so
  (backend errors here were already English).
  `src/lib/transport/commandClasses.ts` did not change: the generated file
  lists names and classes only, and
  `the_generated_command_classes_ts_is_current` passes.

## Gotchas

- Fetch now asks for approval in a repo that has hooks (husky, pre-commit) or
  program-naming config, even though fetch runs no hook. One approval covers
  fetch, commit and push, because they share the `GitHooks` fingerprint.
  `GitPullPanel` fetches on open, so the dialog can appear when the panel
  opens. Declining shows the fetch error and the preview from the last
  tracking refs.
- The privacy pre-commit flags a test key made of `AAAA…` padding as a token.
  The H6 test builds its "other key" in code for that reason.
- The shared `CARGO_TARGET_DIR` rebuilds every time another worktree builds,
  so each cargo run here took 5–10 minutes.

## Gate results

Ran `scripts/gates.sh --base 214933ab5`, which selects the branch's whole
diff (frontend and src-tauri):

- **PASS:** brand, whitespace, `npm run lint` (0 errors, 30 warnings, none
  in touched files), clippy ×3 at `-D warnings`, `npm run build`, and
  vitest `--changed` (4493 passed).
- **cargo test -p tabtivity -p app-serverd:** 5527 passed, 1 failed, 12
  ignored in the lib suite. The other suites passed (145 + 39 + 1, run with
  `--no-fail-fast`).
  - The one failure is
    `git_push_mcp::tests::push_branch_patterns_reads_the_yaml_shapes_and_names_nothing_for_the_rest`.
    It is a wall-clock assert (alias-bomb parse under 5 s) that took 6.3 s
    while three implementers shared the machine and the target dir.
  - It passes alone in 0.13 s, and nothing here touches `git_push_mcp` or
    YAML. It failed the same way in both full runs, so treat it as a
    load-sensitive test that can fail on the merged tree too.
- **cargo test daemon build** (`--no-default-features --lib --test
  server_secrets`): 5349 passed, 11 ignored, plus 1. Run separately because
  the gate run stopped at the failure above.
- **New regression tests, all passing:**
  - `a_link_under_a_link_from_the_same_bundle_is_never_created` (unix)
  - `a_remote_state_section_keeps_only_the_carried_files`
  - `fetch_is_gated_on_the_repos_program_keys` (unix)
  - `approved_for_needs_a_current_approval_and_never_asks`
  - `poetry_runs_only_in_an_approved_folder`
  - `box_agent_docs_are_never_written_through_a_link` (unix)
  - `trusted_host_key_lines_keep_only_the_shown_key_for_this_host`
  - the extended `exec_config_keys_are_recognised`
  - the updated HostKeyConfirm and HostKeyOnce vitest suites
  - `the_generated_command_classes_ts_is_current` still passes.
- `npm run backend:stale` was not run: this is a worktree, and the
  coordinator runs it on the merged tree.

## Flagged for user

- **H6 edits another app's file.** Trust still appends to the user's real
  `~/.ssh/known_hosts` (plan: unchanged). AGENTS.md says Tabtivity never
  edits another app's paths or config. The alternative is a known_hosts
  file of Tabtivity's own, passed with `UserKnownHostsFile`.
- **H8 approval is not content-bound to Poetry.** `approved_for` treats an
  approval of *any* kind (in practice the repo's git hooks or a latexmkrc in
  the same folder) as permission to run Poetry there. It is not a
  fingerprint over `pyproject.toml` / `poetry.toml` / `.poetry/`, so a
  folder whose hooks were approved can still ship a malicious Poetry plugin.
  Folders with no approval, which is most of them, lose the Poetry entry in
  the interpreter picker. The stronger fix is a `TrustKind::Poetry` over
  those files, plus a prompt from the picker. That needs new UI and i18n,
  which the plan excluded.
- H4: the trust dialog's title for this kind reads "Run this repository's
  git hooks?", which is slightly off when Fetch triggers it (see To apply).
- Not done (out of scope, noticed): `git_publish.rs` `gh`/`glab` calls with
  unsanitised repo config (slice 03 finding 2's audit note), and zip
  bomb budgets in `extract_section` (slice 03 #8).

## To apply

- `src/lib/i18n/en.ts` (optional, owned by C): retitle
  `execTrust.title.gitHooks` to cover fetch, e.g. "Run this repository's git
  hooks and configured programs?". The other dictionaries would need the
  same change.
- `docs/filemap_backend.md`: no row change needed (no file added or
  reshaped). If `services/exec_trust.rs` has a row, it may add "silent
  `approved_for` for optional probes (Poetry)".
- `src/lib/untested.ts`: none (these are hardening fixes, not features).
