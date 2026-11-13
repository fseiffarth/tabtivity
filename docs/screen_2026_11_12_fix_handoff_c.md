# Screen 2026-11-12 — handoff C (H7, H10, H12, H13)

Plan: `docs/screen_2026_11_12_fix_plan.md`. Worktree branch
`worktree-agent-a76382eec5420a05b`, based on develop `214933ab5`. Nothing
was pushed, run live or released.

## Commits (apply in this order)

| sha | item | one line |
|---|---|---|
| `cabb09e6a` | H7 | `fix(mobile)`: the PWA builds the sign-in text itself and refuses a challenge whose `payload` differs |
| `d4bdadcce` | H10 | `fix(editor)`: closing a file tab with unsaved edits and autosave off asks Save / Discard / Cancel |
| `0812e3383` | H12 | `fix(hooks)`: pre-push bumps only a push of the checked-out branch; the re-push carries every ref |
| `dd41899da` | H13 | `fix(ci)`: release.yml waits for the commit's `security.yml` push run as well as ci-cd |

## Choices

**H7** (`mobile-web/src/auth.ts`)
- `loginPayload(origin, deviceId, nonce, expiresAt)` builds
  `[NAMES.mobileAuthContext, origin, deviceId, nonce, expires_at].join("\n")`.
  `auth.rs::challenge` builds the same text, and `host.rs` already sends
  `expires_at`. No server change.
- `checkedLoginPayload` checks the nonce against `^[A-Za-z0-9_-]{1,64}$` (the
  same check as `signedAction`) and requires `expires_at` to be a
  non-negative safe integer. It returns the text only when the server's
  `payload` equals it exactly; otherwise `null`. On `null`, nothing is
  signed, nothing is posted, and `login` throws a plain
  `Error("invalid_challenge")`.
- `resumeAuth` reports that error as `unavailable` (`server_error`), not
  `unpaired`. Re-pairing would only give the same server a new key. It is
  not retried.
- `origin` is `location.origin`. The host's `exact_origin` already requires
  the request's Origin to equal `config.origin`, so the two match.
- New `NAMES.mobileAuthContext` in `src/lib/brand.ts`, in the backend-shared
  section. `BrandMirror.test.ts` checks it against `MOBILE_AUTH_CONTEXT` /
  `LEGACY_MOBILE_AUTH_CONTEXT` in `brand.rs` with no test edit. Only the
  current brand's context is accepted, because the PWA and the server ship
  in the same binary.

**H10** (data loss on tab close)
- New `src/lib/tabs/tabCloseGuard.ts` holds a per-heap registry of
  `(scope, tabKey) → guard` and `PaneUnsavedContext`.
- New `src/components/tabs/TabCloseGuard.tsx`:
  - It collects the pane parts' unsaved work and owns a `useDialogs()`.
  - It asks with `chooseOption` (the shared `ChoiceDialog`): **Save and
    close** (current/default), **Close without saving**, and the dialog's
    own Cancel.
  - Save calls `DraftSaver.flush()`. The tab closes only if nothing is still
    unsaved afterwards, so a failed save keeps the tab and the viewer shows
    the error.
  - A second close while the question is open waits for the same answer.
- `TabPane` wraps only the `embed` and `projectfiles` kinds, the two that
  can hold a `useEditableFile` viewer. Terminals are untouched.
- `useEditableFile` registers `{ lostOnClose: saver.lostOnDispose, save:
  saver.flush, label: basename(path) }`. New getter `DraftSaver.lostOnDispose`
  = dirty && autosave off. With autosave on, `dispose` still flushes as
  before and nothing asks.
- `closeTabInScope` now returns `Promise<boolean>`:
  - With nothing to lose, it closes synchronously before returning, exactly
    as before. Existing callers and tests keep their timing.
  - Otherwise it asks, and closes only on Save or Discard.
  - `closeTabWithConfirm` returns the same promise.
  - New `closeTabsWithConfirm(keys)` closes one tab at a time and stops at
    the first Cancel. TabBar's close-left, close-right, close-others and
    close-stack use it, so two unsaved tabs never stack two dialogs.
  - The phone's `closeMobileTab` now awaits it. The phone only closes
    tmux tabs, which never have a guard.
- Strings: `fileViewer.closeUnsavedTitle` / `Body` / `Save` / `Discard`, in
  all five dictionaries. The parity tests require every language to hold
  every English key.
- DeckView's header comment ("Tabtivity has no unsaved-work prompt
  anywhere — `closeTabWithConfirm` is literally `removeTab`") was reworded,
  because it is no longer true.

**H12** (`.githooks/pre-push`)
- `head_ref="$(git symbolic-ref -q HEAD || true)"`. A ref is bumpable only
  when `local_ref == head_ref`.
- Any other branch ref prints one line and goes out un-bumped:
  `pre-push: not bumping feature: only a push of the checked-out branch
  (develop) is version-bumped.`
- A detached HEAD is never bumped, and no note is printed for `HEAD:x`
  pushes, the same as before.
- The plan also asked for the reviewer's "re-push the exact pair". I made
  that change because it falls on the same path: when a bump runs, the
  re-push names every ref the aborted push named. The checked-out branch
  goes as `HEAD:<its remote ref>`, every other ref as
  `<local sha>:<remote ref>`, and a deletion as `:<remote ref>`.
  - Before, bare `git push "$remote" HEAD` went wherever `push.default`
    pointed. It dropped a tag or a second branch pushed alongside, and sent
    `develop:other` to develop.
- The privacy scan loop is unchanged.
- Verified with a throwaway script (appendix below) against a temp local
  bare remote, using a stub `bump-version.sh` and `privacy-check.sh`:
  - Against the old hook it fails 12 of 17 checks, reproducing the
    finding: `git push origin feature` from develop bumped and pushed
    develop, and feature never left.
  - Against the new hook all 17 pass.
  - Cases: another branch; the checked-out branch; branch + second branch +
    annotated tag; `develop:refs/heads/other`; detached HEAD.

**H13** (`.github/workflows/release.yml`)
- The wait step (`id: ci`, now "Wait for the commit's ci-cd and security
  runs to pass") wraps the old loop in `wait_green <workflow> <name>`. It
  calls it for `ci-cd.yml` (its `run_id` output is unchanged) and then for
  `security.yml`.
- Same query (`head_sha=$SHA&event=push`, v* tag runs excluded), same
  verdicts, and one shared 130-minute deadline and 10-minute appear
  deadline. Security runs beside ci-cd from the same push, so it has
  normally finished by then.
- Header comments were updated. Pins are unchanged, and no new `${{ }}`
  expressions were added.
- Verified by extracting the step's `run:` from the parsed YAML and running
  it against a stub `gh`, with simulated time for `sleep`:
  - both green → exit 0, `run_id=<ci>`;
  - security red → refuse;
  - security still running, then green → exit 0;
  - ci red → refuse, security never asked;
  - only a v-tag security run → refuse after the appear deadline.

## Gotchas

- `closeTabInScope` used to return `void`. A test that mocks it with
  `vi.fn()` still works (`TabCostList.test.tsx`). New code that needs to
  know whether the tab closed should await it.
- The guard lives in the heap that renders the pane. A close made from the
  main window for a tab shown in a popout cannot see the popout's buffer.
  That gap is unchanged.
- An inline editor's half-typed cell (YAML grid, Bib card) is committed to
  the draft only on blur. The close question does not blur first, so such a
  value can still be lost. `settleUnsavedWork` (the popout retire path)
  does blur.
- Shell edits in this worktree: heredocs or long `python3 -c` with paths
  are refused by the worktree guard. Use Write plus a script file.

## Gate results

`scripts/gates.sh --base 214933ab5` over the four commits. The gate runner
chose all ten gates, since it counts `.github`/`.githooks` as touching the
backend.

- **Passed** (all at zero warnings):
  - brand
  - whitespace
  - `npm run lint` (no errors)
  - all three clippy variants
  - `npm run build`
  - vitest `--changed`: 504 files, 4493 tests. `brand.ts` changed, so
    nearly the whole suite ran.
- **`cargo test -p tabtivity -p app-serverd`** failed once, on a timing
  flake in code this branch does not touch:
  - The test was
    `git_push_mcp::tests::push_branch_patterns_reads_the_yaml_shapes_…`.
    Its alias-bomb case took 6.3 s under parallel load against a 5 s
    limit.
  - Re-run alone it passes in 0.11 s.
  - Then `cargo test -p tabtivity -p app-serverd --no-fail-fast`: 7
    binaries, 5706 passed, 0 failed.
- **`cargo test -p tabtivity --no-default-features --lib --test
  server_secrets`**: 5342 + 1 passed, 0 failed (run by hand after the
  flake stopped the gate run).
- No Rust changed in this branch.
- Extra checks:
  - the `MobileAuth` + `BrandMirror` suites: 43 tests;
  - the whole `src/__tests__/mobile` dir + `ServerSecrets`: green;
  - `TabCloseUnsaved.test.tsx`: 7 tests;
  - the pre-push temp-repo script: 17/17;
  - the release.yml wait-step simulation: 5 cases.

## Flagged for user

- **H10 scope:**
  - Only the `useEditableFile` viewers ask: Text, Markdown, TeX and the
    Table view's text mode.
  - These still close without asking: `closeGroup` (closing a whole
    subwindow), `closeAllTabs` and project close/quit. PDF notes and
    pages, CompareView and DeckView register only with the popout-retire
    registry and are not covered either.
  - Switching to another project unmounts its panes. With autosave off,
    an unsaved buffer may go with them; not checked.
  - Each of these needs its own decision.
- **H12 force pushes:** `git push --force origin develop` from develop still
  bumps and re-pushes without `+`, which is then rejected as
  non-fast-forward. This is pre-existing and unchanged. Carrying a `+` when
  the hook cannot tell a forced push from an unforced one would turn a
  rejected push into a forced one.
- **H13:** a red `security` push run now blocks the release until it is
  re-run green or fixed, including an advisory with no code change in the
  push. The weekly cron runs (event `schedule`) do not count either way.
- **H12 is not live-verified against GitHub.** Per the brief, only a temp
  local bare remote was used.
- **H7** is unit-tested only. No phone sign-in was run live.

## To apply

- **Phone bundle:** H7 changes `mobile-web/`, so run `npm run mobile:bundle`
  after landing. The running sidecar serves the old bundle until the binary
  is rebuilt (the post-commit hook already reports "EMBEDDED MOBILE PWA IS
  STALE").
- **Untested register** (`src/lib/untested.ts`, not mine to touch):
  - Add a row such as `desktop.tabCloseUnsaved` for H10.
  - Pass it as `untested: "desktop.tabCloseUnsaved"` in the `chooseOption`
    spec in `src/components/tabs/TabCloseGuard.tsx`.
  - H7 has no UI.
- **Filemap rows** (`docs/filemap_frontend.md`):
  - new, near `lib/tabs/tabScopeContext.ts`: `| \`lib/tabs/tabCloseGuard.ts\` | Per-heap
    \`(scope, tabKey) → guard\` registry + \`PaneUnsavedContext\`: \`closeTabInScope\`
    asks the tab's guard before a close that would lose unsaved work (autosave off). |`
  - new, near `tabs/paneTabContext.ts`: `| \`tabs/TabCloseGuard.tsx\` | Wraps
    embed/projectfiles panes: collects \`useEditableFile\` buffers, asks Save /
    Discard / Cancel (\`useDialogs().chooseOption\`). Tests: \`TabCloseUnsaved.test.tsx\`. |`
  - amend `lib/remote/closeRemoteTab.ts`: add "`closeTabInScope` resolves
    whether the tab closed; asks first through `tabCloseGuard`;
    `closeTabsWithConfirm` closes one by one, stops at Cancel."
- **Docs:**
  - `docs/context/release_signing.md` § "How a release is cut" says the
    release waits for ci-cd only; add security.yml.
  - The `security.yml` header comment says gitleaks lives in ci-cd "so it
    can gate the release job". That is still accurate, but now the whole
    workflow gates the release too.

## Appendix — the pre-push check script

Usage: `prepush_check.sh <hook copy> <empty scratch dir>`. Run it with
`TABTIVITY_BUMPING` / `TABTIVITY_PUSH_PREFLIGHT` unset. It needs `jq`. Its
remote is a local bare repository only.

```bash
#!/usr/bin/env bash
# Scripted check of .githooks/pre-push's bump rule against a throwaway local
# bare remote. Usage: prepush_check.sh <hook path> <scratch dir>
set -uo pipefail
hook="$1"; base="$2"
rm -rf "$base"; mkdir -p "$base"
git init -q --bare "$base/remote.git"
git init -q -b develop "$base/work"
cd "$base/work"
git config user.name t; git config user.email t@example.invalid
git config core.hooksPath hooks
mkdir -p hooks scripts src-tauri
cp "$hook" hooks/pre-push; chmod +x hooks/pre-push
printf '#!/usr/bin/env bash\nexit 0\n' > scripts/privacy-check.sh
cat > scripts/bump-version.sh <<'EOF'
#!/usr/bin/env bash
set -e
v="$(jq -r .version package.json)"; IFS=. read -r a b c <<<"$v"; n="$a.$b.$((c+1))"
jq --arg n "$n" '.version=$n' package.json > package.json.t && mv package.json.t package.json
echo "$n"
EOF
chmod +x scripts/*.sh
echo '{"version":"0.1.0"}' > package.json
for f in package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock; do echo x > "$f"; done
touch "$(git rev-parse --git-dir)/tabtivity-release-signing-secret-ok"
git add -A; git commit -qm init
git remote add origin "$base/remote.git"
git branch feature
TABTIVITY_BUMPING=1 git push -q origin develop feature

fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' want '$3'"; fail=1; fi; }
rsha() { git --git-dir="$base/remote.git" rev-parse "$1" 2>/dev/null; }
rver() { git --git-dir="$base/remote.git" show "$1:package.json" | jq -r .version; }

# 1. From develop, push another branch: it goes out as it is; develop untouched.
git checkout -q feature; echo f1 > f1; git add f1; git commit -qm f1; git checkout -q develop
dev_before="$(git rev-parse develop)"
out="$(git push origin feature 2>&1)"; code=$?
check "other-branch push exits 0" "$code" 0
check "feature published exactly" "$(rsha feature)" "$(git rev-parse feature)"
check "feature not bumped" "$(rver feature)" "0.1.0"
check "develop left alone locally" "$(git rev-parse develop)" "$dev_before"
check "develop left alone on the remote" "$(rsha develop)" "$dev_before"
case "$out" in *"not bumping feature"*) echo "ok   note printed";; *) echo "FAIL no note: $out"; fail=1;; esac

# 2. The checked-out branch: bumped and re-pushed.
echo d1 > d1; git add d1; git commit -qm d1
git push -q origin develop >/dev/null 2>&1
check "develop bumped" "$(rver develop)" "0.1.1"
check "remote develop = local develop" "$(rsha develop)" "$(git rev-parse develop)"

# 3. The checked-out branch with another branch and a tag: all three arrive.
echo d2 > d2; git add d2; git commit -qm d2
git checkout -q feature; echo f2 > f2; git add f2; git commit -qm f2; git checkout -q develop
git tag -a t1 -m t1 feature
git push -q origin develop feature t1 >/dev/null 2>&1
check "develop bumped again" "$(rver develop)" "0.1.2"
check "remote develop = local develop" "$(rsha develop)" "$(git rev-parse develop)"
check "feature carried along exactly" "$(rsha feature)" "$(git rev-parse feature)"
check "tag carried along" "$(rsha refs/tags/t1)" "$(git rev-parse refs/tags/t1)"

# 4. The checked-out branch to another remote name: lands there, not on develop.
echo d3 > d3; git add d3; git commit -qm d3
dev_remote="$(rsha develop)"
git push -q origin develop:refs/heads/other >/dev/null 2>&1
check "other got the bumped HEAD" "$(rsha other)" "$(git rev-parse develop)"
check "remote develop untouched" "$(rsha develop)" "$dev_remote"

# 5. Detached HEAD: no bump, no commit made.
git checkout -q --detach; echo x1 > x1; git add x1; git commit -qm x1
head_before="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/detached >/dev/null 2>&1; code=$?
check "detached push exits 0" "$code" 0
check "detached push not bumped" "$(git rev-parse HEAD)" "$head_before"
check "detached published exactly" "$(rsha detached)" "$head_before"

exit "$fail"
```
