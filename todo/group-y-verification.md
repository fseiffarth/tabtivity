## Group Y — Verification, Release Gates & Code Health

*Created 2026-07-28 from a full-repo evaluation + a 148-item backlog
reconciliation. These are gaps in the **machinery that checks the work**, not in
the product. They had no TODO entry of any kind, which is itself the finding:
nothing was tracking them because nothing was failing loudly.*

*Files: `.github/workflows/ci-cd.yml`, `.githooks/pre-push`, `package.json`,
`scripts/privacy-check.sh`.*

**Why this group outranks feature work.** The repo has ~4100 automated tests
(1630 `cargo test`, 2476 vitest) and **227 manual-QA items, each now a
Works/Doesn't-work pair, of which exactly two have ever been confirmed
Works**. Verification cost is roughly constant per feature; *deferred*
verification cost is superlinear, because a defect found later must be bisected
across dozens of unvalidated layers instead of one. That inversion — not any
missing capability — is the project's dominant risk.

161. ~~**The 2476-test frontend suite never runs in CI.**~~ **DONE 2026-07-28.**
     A `Run frontend tests: npm test` step now sits beside the `cargo test` step
     in all three test jobs (`test`, `test-windows`, `test-macos`). Baseline at
     the time of wiring: 215 files / 2476 tests green in ~52 s.
     - [x] 🤖 Automated test — a deliberately failing component test makes
       `vitest run` exit 1, which is what the new CI step keys off (verified
       locally with a throwaway spec; the step itself is one `npm test` call).
     - [ ] 🖐️ Manual test — push a branch with a failing vitest and watch CI red.
       *Still open: nothing has watched this go red on GitHub yet.*
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

162. ~~**`privacy-check.sh` is mandated but wired to nothing.**~~ **DONE
     2026-07-28.** Wired in both places, because neither alone is enough — the
     hook needs `git config core.hooksPath .githooks` per clone, and CI cannot
     stop a push.
     - `scripts/privacy-check.sh` now takes optional `git diff` arguments, so
       `<base> <head>` scans a commit range while the documented bare call still
       scans the index. `PRIVACY_CHECK_SKIP_IDENTITY=1` drops the `$USER`/`$HOME`
       patterns, which on a CI runner match the *runner's* identity and nothing
       the developer owns.
     - `.githooks/pre-push` scans each pushed ref **before** the version bump, so
       a hit aborts without leaving a stray bump commit. The base is the remote
       tip, or — for a brand-new remote branch — the parent of the oldest commit
       no remote branch has yet, falling back to the empty tree at a root commit.
       `TABTIVITY_SKIP_PRIVACY_CHECK=1` is the documented one-time override.
     - A `privacy` CI job runs the same scan over `merge-base(base, head)..head`
       and now **gates all three package jobs**: a leak must never become a
       downloadable artifact, let alone a release asset.
     - [x] 🤖 Automated test — verified end to end in a throwaway repo wired with
       the real hook and script: a clean commit pushes, and a commit adding a
       fake GitHub personal-access token prints the match and aborts the push
       with rc=1. (The literal is kept out of this file on purpose — writing it
       here would trip the very scan it documents.)
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

163. **No mechanical quality gate at all.** **MOSTLY DONE 2026-07-28** — the two
     halves that catch defects are in; `cargo fmt --check` is not, and that is
     the remainder of this item.
     - A `lint` CI job now runs `npm run lint` and
       `cargo clippy --all-targets -- -D warnings`. Linux-only: neither verdict
       is platform-dependent, so running it three times buys nothing.
     - `eslint.config.js` is deliberately narrow — hooks rules, a handful of
       defect-shaped rules, unused-vars — and **green on the day it landed**
       (0 errors, 30 advisory warnings: 27 `exhaustive-deps`, 3 `no-explicit-any`).
       A gate that lands with 400 pre-existing violations gets `--no-verify`'d
       into irrelevance within a week. Three rules are off with the reason
       recorded in the config (`no-control-regex` — terminal/markdown match
       control characters on purpose; `no-unmodified-loop-condition` — cannot see
       `date.setDate()` mutation, 2 false positives and 0 true ones;
       `no-this-alias` limited to `self`). Type-aware linting is off because
       `npm run build` already runs `tsc`.
     - Getting clippy to zero took ~83 fixes: `--fix` for the mechanical ones,
       then `sort_by_key`, `slice::from_ref`, `contains_key`,
       `field_reassign_with_default`, doc-paragraph breaks, and `//!` file docs
       in four test files. Four sites got a *local* `#[allow]` with a stated
       reason (`assertions_on_constants` ×2 — the constant value is the property
       under test; `large_enum_variant`; `unusual_byte_groupings` ×2 — hex seeds
       spelled as words). Exactly one crate-wide allow, in `lib.rs`:
       `too_many_arguments`, because a `#[tauri::command]` spends its first
       parameters on `AppHandle` + `State<'_, …>` injection before one of its own.
     - Ten dead `eslint-disable-next-line` comments were removed — written in
       anticipation of a linter that never ran, and unnecessary once one did.
     - **Remaining: `cargo fmt --check`.** The backend has never been rustfmt'd
       and differs at **1069 sites (~14k lines)**. Raising `max_width` does not
       help — 110 gives 1062 hunks and 120 gives *1291*, because rustfmt starts
       re-joining lines that were hand-wrapped deliberately. So there is no cheap
       version: enforcing it needs a one-off whole-backend formatting commit,
       which is a large churn for the one gate here that catches no defects.
       Deferred as a deliberate call, not an oversight.
     - [x] 🤖 Automated test — the gate is the test: `npm run lint` and
       `cargo clippy -- -D warnings` both exit 0 on the current tree, and both
       suites (2476 vitest / 1630 cargo) stay green across every fix above.
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

164. **First live-QA session — unblock the 145 manual boxes.** `TODO.md`'s
     verification section used to say *"do not launch Tabtivity from the agent"*,
     contradicting `CLAUDE.md`'s explicit 2026-07-28 permission; that line was
     removed on 2026-07-28 and this item replaces it. Pick the three
     most-shipped subsystems and QA them by hand **before starting a fourth
     product**. Roughly twenty subsystems are simultaneously code-complete and
     never-run — 109 `<UntestedTag>` instances across 54 components.
     - Highest-value targets, in order: (a) **J#66 mail crypto** — an XChaCha20
       store and an OpenPGP path that have never met a real server; both failure
       modes are *silent* (an unopenable mailbox and a mis-verified signature
       both look fine). (b) **J#61 gating check** — one test, `invoke('list_projects')`
       must reject from a live page's devtools; its result decides ship-vs-delete
       for the whole browser track and #61a/#61b hang off it. (c) **V#90 deck
       presenter** — code-complete, never run, and #93/#94 both lose authored
       work with no prompt.
     - [ ] 🖐️ Manual test — this item *is* the manual test.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - *Status 2026-07-28: not started, and not startable unattended.* (a) mail
       crypto needs a real IMAP/SMTP account and a correspondent's OpenPGP key —
       neither exists in this environment; (b) the `invoke('list_projects')`
       gating check must be typed into a **live page's** devtools, which is the
       one surface an agent driving the app cannot reach; (c) the deck presenter
       needs a second monitor to mean anything. Needs a human at the keyboard.

165. **Security items promoted by the 2026-07-28 audit.** Not new work — these
     already live in Group O, but the audit ranked them above the feature
     backlog and nothing recorded that. Cross-reference only — **all four have
     since moved**, so this entry now points at Group O rather than restating
     stale detail:
     - **O#149** — **DONE 2026-07-29.** `pty_spawn` now validates `cwd` against
       the owning project's directory/mirror. See Group O for the shape.
     - **O#143** — **DONE 2026-07-28** (shipped the same day as this audit,
       just after it was written). Adoption now requires an explicit confirm;
       detection is pure. See Group O.
     - **O#59** — **PARTIALLY DONE 2026-07-28.** A real per-project override
       shipped (force `claude --remote-control` on/off per project); the
       global default deliberately stays ON — flipping it was judged a bigger,
       separate UX call nobody had asked for. See Group O for the reasoning.
     - **O#151 residual** — **MITIGATED 2026-07-28, not fully closed.** The
       `filter.<driver>.clean` residual named here is closed (a config
       denylist matching by key *shape*, so an attacker's driver name doesn't
       matter); `.git/hooks/*` and `credential.helper`/`core.sshCommand` on
       **user-initiated** git actions remain open by deliberate choice — see
       Group O for which and why.

166. **Three god-files concentrate most of the maintenance risk.** Not urgent,
     but untracked until now, and each is a file that *every* feature in its
     area must touch:
     - `src/components/embed/FileViewerPane.tsx` — **6689 lines, 25 React
       components in one file** (`FileViewerPane` `:313`, `CodeEditor` `:1783`,
       `TextView` `:4992`, `MarkdownView` `:5479`, `TexView` `:5827`, plus the
       SLURM bar, AI controls, blame, print and compare surfaces). Should be a
       directory. This is the single least reviewable file in the repo.
     - `src/stores/tabs.ts` — 4383 lines exposing **124 actions** on one store,
       reached into by every pane; the frontend's true god-module.
     - `src-tauri/src/commands/projects.rs` — 3938 lines, 46 Tauri commands. Its
       own file map already calls it *"god module; #1"*.
     - Context for scale: **442 `#[tauri::command]` definitions** repo-wide
       (typical Tauri apps ship 20–80), all reachable from the `main` webview.
       `capabilities/default.json` scopes correctly *by webview label*, so the
       CSP plus that scoping is the real perimeter — see O#144.
     - Splitting these is mechanical but wide; do it behind the green vitest
       suite from #161, never before.
     - *Status 2026-07-28: **unblocked**, not started.* #161 landed, so the
       precondition this item names is now satisfied — the vitest suite runs in
       CI and would catch a bad split. Left for a dedicated pass: ~15k lines
       across three files, and it wants to be the only thing in its commit.
     - [ ] 🤖 Automated test — existing suites must stay green across the split
       (`FileViewerPane` is imported by 19 test files, `tabs.ts` by 61).
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

167. **The frozen dev build goes stale between commits.** ✅ DONE 2026-09-03
     (code-complete, one live build verified; the coalescing and failure paths
     are unproven). `npm run package:dev` freezes the working tree, so the
     window the day's work happens in was only ever as fresh as the last time
     somebody remembered to re-run it — the same class of silent drift the
     embedded-PWA notice exists for, one level up. The `post-commit` hook now
     queues `scripts/package-dev-auto.sh --queue` after the stale-PWA check:
     - **Detached**, so `git commit` returns immediately and closing the
       terminal does not take the build with it.
     - **Coalesced** through a pending marker plus a pid'd lock directory: a
       commit landing mid-build earns exactly one more pass, so a rebase costs
       one or two builds and the installed binary matches the LAST tree.
     - **Low priority** (`chrt --idle 0` + `ionice -c 3` + `nice -n 19`) — a
       3-4 minute release build at full tilt is felt in every keystroke of the
       window it exists to serve.
     - **Declines** in CI, from a linked worktree (freezing an agent's tree
       over the user's binary is the surprise this must not be), and under
       `git config tabtivity.autoDevBuild false` / `TABTIVITY_NO_AUTO_DEV_BUILD=1`.
     - **Skips a no-op**: the signature is HEAD plus the dirty tree, stamped
       after each successful install.
     - Builds and installs only. It never launches or stops Tabtivity; a running
       frozen window keeps its old inode, and the completion notification is
       what says to relaunch.
     - **Since 2026-09-13/14 it freezes the commit, not the tree** (`374c650`,
       `0c449ca`, `af6f0c9`, `5d1389b`): `package-dev.sh --head` checks `HEAD`
       out into the detached worktree `target/freeze-tree` (node_modules
       symlinked, kept out of `git clean`; cargo target dir shared) with its own
       git environment, so a hook's inherited `GIT_DIR`/`GIT_INDEX_FILE` cannot
       point the checkout at the main tree, and it falls back to a plain build
       when inotify is out of watches. From an agent tab it builds and stops;
       `start-tabtivity-dev-build.sh` adopts `target/release/tabtivity` on its `.frozen`
       record (`2aa8f34`). The "dirty tree" signature and "LAST tree" wording
       above predate this; AGENTS.md holds the current contract.
     - [ ] 🖐️ Manual test — with uncommitted edits in the tree, commit an
       unrelated file: the frozen binary's version names the commit without
       "+local", and the uncommitted edits are not in it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - [ ] 🖐️ Manual test — commit twice in quick succession: expect one
       "rebuilding the frozen snapshot" line per commit, a single build in
       `~/.local/share/tabtivity/package-dev-auto.log` with a second pass at the
       end, and one "Tabtivity (dev) rebuilt" notification naming the newer sha.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - **A failed pass stopped the queue (2026-09-15), fixed, not
       live-tested.** A change split over two commits (`50465af` registered a
       Tauri command `8078639` only then defined) made pass 2 fail; the loop
       `break`ed on the failure with the compiling commit still queued, and
       `--status` read "idle / a rebuild is queued" while the icon opened a
       build three commits old — the hook's failure notification never
       arrives from an agent tab. Now the loop goes on while `.pending`
       exists, a failure is recorded in `package-dev-auto.failed`, `--status`
       and `backend:stale` print it plus "N commit(s) behind HEAD", the
       `.frozen` record is installed beside `tabtivity-dev` (by `package-dev.sh`
       and by the launcher's adoption), and the launcher — in the user's own
       session — notifies how far behind the snapshot it opens is and why.
     - [ ] 🖐️ Manual test — make a commit that does not compile, then one
       that fixes it, within a minute: the log shows pass 1 failing, "a newer
       commit is queued — building it despite the failure", and pass 2
       succeeding; `scripts/package-dev-auto.sh --status` shows no failure
       afterwards. Then relaunch "Tabtivity (dev)" with two unfrozen commits
       (`git config tabtivity.autoDevBuild false` for the test): a notification
       says "2 commit(s) behind".
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - [ ] 🖐️ Manual test — `git config tabtivity.autoDevBuild false`, commit:
       expect no line, no build, and `--status` to say why.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - [ ] 🖐️ Manual test — break the build (a type error), commit: expect the
       critical notification pointing at the log, and the previously installed
       binary left untouched.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

168. **Release A of the rename (Eldrun → Tabtivity): the upgrade has never run
     live.** The flip is on the `rename` branch (`docs/rename_phase3_handoff.md`);
     the migrator's launch steps passed against a *copy* of a real install
     (`scripts/brand-copy-run.sh`), nothing else was run. Before merging to
     `develop`: the post-commit hook freezes every commit there into the dev
     build, so the first launch after the merge IS the migration of the real
     install.
     - [x] 🤖 Automated test — `cargo test brand_migration` (upgrade, fresh
       install, crash mid-step, second run), `BrandMigration.test.ts`,
       `BrandMirror.test.ts` (static pages, the pre-paint fallback).
     - [ ] 🖐️ Manual test — upgrade an existing install with a packaged build:
       one entry in the app menu / package list; projects, tabs, UI settings
       and theme (first paint included) and agent sessions restore; the phone
       host restarts under its new name and the phone stays paired; mail
       unlocks; remote tmux sessions reattach; `eldrun-send` and
       `tabtivity-send` both work in a fenced tab; Settings → Updates lists
       what was still found under the old name; `npm run backend:stale` and
       the frozen build still find the binary.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS
     - [ ] Not built: the NSIS hook that removes the old Windows install (it
       cannot be verified here); the webview-data copy on Windows and macOS
       (paths unknown); a retake of `screenshots/eldrun-current.png`.

---
