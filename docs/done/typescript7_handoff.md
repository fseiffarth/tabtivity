# TypeScript 7 type-check — implementer handoff

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

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

## Reviewer (2026-10-14)

Reviewed `dafecadd..1b7a248e` in the same worktree.

### Checked

- **Bare `tsc` consumers.** `rg` over the whole tree (package.json — the only
  one —, `scripts/**`, `.githooks/**`, `.github/**`, vite/vitest/eslint
  configs, `src-tauri/tauri.conf.json`, AGENTS.md, `docs/context/`,
  DOCUMENTATION.md, README.md): only the two package.json scripts run a
  compiler, both by path. `beforeBuildCommand` is `npm run build`; CodeQL
  ships its own TS extractor; no `.vscode/` tsdk. The only live instructions
  naming a bare `tsc` were TODO.md:41/262 (`npx tsc --noEmit`) — fixed below.
  Older plan/handoff docs mention it as history; left alone.
- **`.bin/tsc`**, reproduced in a scratch copy: `npm ci` from the lock → 5.9.3
  (twice), and a no-op `npm install` after it keeps 5.9.3. An install that
  *adds* the alias to a dafecadd tree (the landing case) → 7.0.2, and it stays
  so across later installs. `npm rebuild typescript --ignore-scripts` relinks
  it to 5.9.3 without touching the lock — added as a landing step (below).
- **Lock:** vs dafecadd, adds exactly `typescript-native` + 20
  `@typescript/typescript-*` (all with `resolved` + sha512 `integrity`,
  `optional`, `os`/`cpu`, no `libc`; linux-x64, win32-x64, darwin-arm64,
  darwin-x64 present); the only changed entry is the root's
  `devDependencies`; nothing removed; `typescript` still 5.9.3; libc count
  34 = 34. `npx -y npm@11.21.0 ci --ignore-scripts` in scratch reproduced
  with the lock byte-identical and the native tsc at 7.0.2.
- **tsconfigs:** 5.9.3 and 7.0.2 both exit 0 on both files. With `types: []`
  every test file is in the program (bar one, see Flagged) and the
  vitest-globals config doesn't matter: the tests import from `vitest`
  explicitly, so dropped auto-`@types` would surface as errors, not silently.
- **ProjectFilesTab:** `find` gives `undefined` where the old code gave
  `null`; the outer `??` treats both alike. Behaviour-preserving.
- **dependabot.yml** parses (PyYAML); the npm `ignore` entries match T2.
  AGENTS.md wording accurate and short.
- **Windows:** npm runs scripts under `cmd.exe`; `&&` chains and
  `node node_modules/…/bin/tsc` (forward slashes) work there. The launcher
  adds `.exe` on win32; `.nvmrc` 24 has `import.meta.resolve`.

### Fixed

- `bfe957c9` docs(ts): TODO.md's two type-check instructions point at
  `npm run build`; plan decision 1's "5.9 won under both install and ci"
  corrected; T2 landing gets `npx -y npm@11.21.0 rebuild typescript
  --ignore-scripts` after the additive install (check: `readlink
  node_modules/.bin/tsc` = `../typescript/bin/tsc`). No code regression test:
  nothing in the build reads `.bin/tsc`.

### Gates (worktree)

- `npm test -- --reporter=dot`: 817 files, 8293 tests, all passed.
- `npm run lint`: 0 errors, 28 warnings (unchanged).
- `scripts/gates.sh --base develop`: all passed (brand, whitespace, lint,
  build 49 s, related vitest, and — because develop moved, see Flagged —
  clippy ×3 and cargo test ×2 over dafecadd's Rust).
- `scripts/brand-check.sh`, `git diff --check dafecadd..HEAD`,
  `scripts/privacy-check.sh dafecadd HEAD` (4 commits, noreply identities):
  pass.
- `scripts/ci-local.sh --fast` (runs inside the worktree: own git dir and
  target dir; base = merge-base with origin/develop, 11 commits): 22/23 ok,
  gitleaks SKIPPED (not installed); includes the Windows clippy/check and
  macOS check cross-checks and daemon-ldd. 756 s.

### Flagged for user

- **develop moved under the branch:** `d40529e9` (Tauri 2.12 bump) changes
  `package.json` and `package-lock.json`. Per T0, this lands second: rebase
  onto develop and regenerate the lock from that HEAD
  (`npx -y npm@11.21.0 install --ignore-scripts --before=…`), then re-run the
  lock checks above, before copying anything to the main tree.
- The main checkout has an untracked `docs/done/typescript7_plan.md`, identical to
  `40ae3b37`'s; remove it before landing the commits or the checkout
  refuses to overwrite it. (The reviewer's `bfe957c9` edits that file.)
- A later additive install that adds or re-adds either TypeScript package can
  flip `.bin/tsc` again; nothing in the gates cares, so no guard was added.
- Pre-existing, not from this change: `src/__tests__/shell/KeyboardNav.test.ts`
  and `KeyboardNav.test.tsx` share a basename, so neither 5.9 nor 7 puts the
  `.tsx` one in the program — it is never type-checked (vitest still runs it).
