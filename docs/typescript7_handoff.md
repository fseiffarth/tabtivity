# TypeScript 7 type-check — implementer handoff

Plan: [`typescript7_plan.md`](typescript7_plan.md). Done in the worktree
`.claude/worktrees/agent-ac5d11f0b88943110`, on the branch
`worktree-agent-ac5d11f0b88943110`, on top of develop `dafecadd`.
Not landed in the main tree and not pushed: the landing install
(T2's main-tree `npm install`) and T3 (CI) are still open.

## Commits

| sha | step | subject |
|---|---|---|
| `40ae3b37` | — | docs(ts): plan for the TypeScript 7 type-check |
| `5724b816` | T1 | build(ts): tsconfigs and code ready for TS 7 |
| `39982d82` | T2 | build(ts): type-check with TypeScript 7 (native tsc) |
| (this file) | — | docs(ts): TypeScript 7 handoff |

## Choices made within the plan

- The worktree branch was created from `main` (`4b83f362`), not develop. It
  was moved onto develop `dafecadd` (`git reset --hard develop`, inside the
  worktree only, which was clean) before any work.
- The AGENTS.md clause is its own short paragraph right after the gates code
  block, worded "`npm run build`'s `tsc` is TS 7 …" (the code block ends the
  list, so "Its" had no antecedent there).
- The Dependabot comment sits in the npm `ignore` list, above the two new
  entries.
- Commits were made with `TABTIVITY_NO_AUTO_DEV_BUILD=1`: the post-commit
  hook queues a frozen dev build of the **main** tree, which these
  worktree-only commits do not change.
- Install used `npx -y npm@11.21.0 install --ignore-scripts --before=2026-10-07`
  (install day 2026-10-14 minus 7).

## Gotchas

- **Which package owns `node_modules/.bin/tsc` depends on how it was
  installed.** After the additive `npm install` the link pointed at
  `typescript-native` (so `npx tsc --version` printed **7.0.2**). After a
  fresh `npm ci` it points at `typescript` (5.9.3). The plan's "5.9 won under
  both install and ci" did not hold for the incremental install. Nothing in
  the build depends on it (the scripts call the native tsc by path; editors
  and typescript-eslint load `node_modules/typescript` directly), but the
  main tree will be landed with `npm install`, so there `npx tsc` will
  probably be TS 7 until its next `npm ci`.
- `rtk` rewrites `tsc` output (it printed "TypeScript: No errors found" for
  `npx tsc --version`); use `rtk proxy` to see the real output.
- The lock diff adds exactly `node_modules/typescript-native`, the 20
  `node_modules/@typescript/typescript-*` entries and the root
  `devDependencies` line; nothing removed. linux-x64, win32-x64, darwin-arm64
  and darwin-x64 are present. `grep -c '"libc"'` is 34 before and after.

## Verification

- `npm ls --package-lock-only --depth=0` and `npm ls --depth=0`: pass.
  `npm ls typescript`: 5.9.3 under typescript-eslint (all parts) and
  react-doctor, no `invalid`/`ERESOLVE`.
- `node node_modules/typescript-native/bin/tsc --version`: 7.0.2. Both
  `-p tsconfig.json` and `-p tsconfig.mobile.json`: 0 errors, on 7.0.2 and on
  5.9.3.
- A planted type error in a scratch `src/` file fails `npm run build`
  (TS2322 from the native tsc, exit 1); one in `mobile-web/src/` fails
  `npm run mobile:build`. Both removed.

## Gates (worktree, fresh `npm ci`)

- `scripts/gates.sh --base develop` (selects frontend + always): brand PASS,
  whitespace PASS, lint PASS, build PASS (76 s), related vitest PASS. Rust
  gates skipped: no Rust change.
- `npm test -- --reporter=dot`: **817 test files, 8293 tests, all passed**.
  817 is every file the vitest `include` glob matches on disk, so nothing
  was dropped (the pdf.js files collect). Not compared against a main-checkout
  run (not run there, by the rules).
- `npm run lint`: 0 errors, 28 warnings, none in the touched file.
- `npm run build`: green; its only warnings are vite's existing chunk-size
  notices.
- `scripts/brand-check.sh`, `git diff --check`: pass. `scripts/privacy-check.sh`
  passed in each commit's pre-commit hook.
- **Not run:** `scripts/gates.sh --all` (cargo: Rust untouched, and a fresh
  worktree target dir would mean a full workspace build) and
  `scripts/ci-local.sh --fast`. Both belong to landing/before the push.

## Timings (`/usr/bin/time`, 24 cores, 2026-10-14)

| check | 5.9.3 | 7.0.2 |
|---|---|---|
| tsc src | 33.5 s, 1.94 GB (load ~7); 93.7 s at load 60 | **5.2 s**, 1.49 GB (load ~9) |
| tsc mobile | 6.3 s, 0.51 GB; 12.1 s at load 60 | **2.4 s**, 0.42 GB |
| `npm run build` | 85.3 s (load ~5–7); 219 s at load 60 | **52.4 s** (load ~7) |

Load never got below 4, the plan's bar; the pairs above were measured at
similar load, minutes apart.

## Flagged for user

- `npx tsc` in the main tree will likely run TS 7 after the landing
  `npm install` (see Gotchas). Harmless for the gates; mention it if anyone
  relies on `npx tsc` meaning 5.9.
- Open from the plan: landing (T0 re-check, copy `package.json` + lock, main
  tree `npm install`, `npm ls --depth=0`), `gates.sh --all`,
  `ci-local.sh --fast`, then T3 (push, CI on three OSes, frozen dev build).
- Optional, from the plan: report the TS2871 false positive upstream
  (microsoft/typescript-go).
