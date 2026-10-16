# TypeScript 7 type-check — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

**Status: plan only, reviewed** (2026-10-13). Nothing installed into the main
checkout, nothing committed. Probe results below came from scratch installs
(`typescript@7.0.2`, and 5.9.3 + the 7.0.2 alias side by side) run against
the repo's own tsconfigs. The reviewer re-ran every claim marked *verified*.

## Why

`npm run build` is the only type-check gate (AGENTS.md "Gates"), and it runs
`tsc` twice: `tsc` (src) in `build`, and `tsc -p tsconfig.mobile.json` in
`mobile:build`. On TS 5.9.3 the src pass takes ~32–39 s and ~1.95 GB. TS 7
(the Go compiler, `typescript@7.0.2`, published 2026-07-08) does the same
check in ~5 s on a quiet machine. Every `gates.sh` frontend run,
`ci-local.sh`, CI "Build frontend" step and frozen dev build gets faster.
Nothing shipped changes: both tsconfigs set `noEmit`; vite bundles.

## What ships (verified with `npm view`, 2026-10-13)

- `typescript@7.0.2` (`latest`; `7.1.0-dev.*` nightlies on `next`).
  `bin: { tsc }`, a small JS launcher that finds the native binary in
  `@typescript/typescript-<platform>-<arch>`: 20 platform packages, all
  `optionalDependencies` (no `dependencies` key, verified), each with
  `os`/`cpu` and no install script. Linux x64 is 27 MB.
- **No JS compiler API.** The package's `exports["."]` is `lib/version.cjs`,
  plus only `./unstable/*` RPC/AST entry points. `require("typescript")` no
  longer gives `ts.createProgram` and friends.
- `typescript-eslint` (installed 8.65.0, latest 8.71.2) peers on
  `typescript >=4.8.4 <6.1.0`, and so do all 7 `@typescript-eslint/*` parts.
  `react-doctor` (via react-scan) *depends* on `typescript >=5.0.4 <6`.
  `scripts/rename-codemods/{tsmod,tshits}.mjs` do `import ts from 'typescript'`.
  Nothing else in node_modules names typescript. (`@typescript/native-preview`
  stopped at a 2026-07-07 dev build; superseded.)
- Cooldown (`.github/dependabot.yml`: 7 days, majors 30): 7.0.2 is 97 days
  old, so it is eligible.

## Fixed decisions

1. **TS 7 goes in next to 5.9, as an npm alias, not instead of it.**
   `"typescript-native": "npm:typescript@7.0.2"` (exact pin) goes in
   `devDependencies`. `"typescript": "^5"` stays (5.9.3 in the lock). Why:
   replacing it would break typescript-eslint (its peer range stops below
   6.1, and it needs the JS API that 7 no longer exports), react-doctor's
   dependency and the codemods. With the alias every peer stays satisfied and
   nothing warns. Both packages claim the `tsc` bin and npm guarantees no
   winner (5.9 wins under `npm ci`; an install that *adds* the alias to an
   existing tree links TS 7, and it stays so until the next `ci` — reviewer,
   2026-10-14), so **the
   scripts call the native one by path**:
   `node node_modules/typescript-native/bin/tsc`. Verified layout: `bin/tsc`
   is a 2-line ESM shim (package `"type": "module"`; npm's Windows `.bin`
   shim runs it the same way). `lib/getExePath.js` reads the package's own
   name (still `typescript` under the alias), `import.meta.resolve`s
   `@typescript/typescript-<platform>-<arch>` from the hoisted
   `node_modules/@typescript/`, adds `.exe` on win32, and runs it (`execve`
   or `execFileSync`, exit code passed on). `--version` prints 7.0.2; a
   type error exits 1. Nothing else calls a bare `tsc` (rg over scripts/,
   `.github/`, configs). `npx tsc`, editors, the eslint parser (not
   type-aware, `eslint.config.js:11`) and the codemods stay on 5.9, so
   **5.9 then type-checks nothing**: `npm run build` = TS 7 over `src` and
   `mobile-web/src`, then the vite bundles.
   `typescript-native` is **not a registered npm name** (404, verified): a
   squatter could take it. Always write the `npm:typescript@…` spec, never
   a bare `npm install typescript-native`; Dependabot ignores the name (T2).
   The lock pins the real tarball + integrity, so `npm ci` is safe.
2. **tsconfig edits, the same on both compilers** (all verified to pass on
   both 5.9.3 and 7.0.2 with the code fix in step T1):
   - `noUncheckedSideEffectImports: false` in **both** files. TS 6+ defaults
     it to `true`, which caused 7 TS2882 errors in the probe:
     `src/bootstrap.tsx:15-16` (`@fontsource-variable/*`, CSS-only packages)
     and 5 CSS imports in `mobile-web/src` (`main.tsx`, `terminalPreview.tsx`,
     `screens/Terminal.tsx`; mobile has no `vite/client` reference).
     Kept over the alternative (mobile `types: ["vite/client"]` + fontsource
     imports rewritten to `…/index.css`): every side-effect import here is
     CSS, which a `*.css` wildcard satisfies without checking anything,
     bar three `brandMigrationBoot` imports, and `vite build` in the same
     `npm run build` fails on any unresolved import. `false` is 5.9's
     current behaviour, so nothing is lost against today.
   - `types: []` in both. This is TS 6+'s new default; 5.9 still
     auto-includes all ~40 `node_modules/@types/*` (d3, chai, babel, …).
     Stating it keeps the editor's 5.9 view the same as the gate's. No
     `@types/node` is installed; `src` gets `vite/client` from
     `src/vite-env.d.ts` (the only `/// <reference>`); module imports still
     find `@types/d3` etc. Verified: both compilers, both configs, 0 errors
     with all three edits (bar the T1 line on 7).
   - `esModuleInterop: true` in `tsconfig.json`. TS 7 always turns it on
     (`false` is TS5108, verified), so stating it makes 5.9 type default imports
     like 7 does. `tsconfig.mobile.json` already sets it and
     `allowSyntheticDefaultImports`; leave them.
   - Nothing else applies. No `baseUrl`, `outFile`, `downlevelIteration`,
     ES5 target, `node10` resolution or `moduleResolution: classic`. `strict`
     is already explicit. `rootDir`/`outDir` don't matter under `noEmit`.
     `DOM.Iterable` still exists (as a stub folded into `DOM`); keep it. TS 7
     printed no deprecation diagnostics for either file.
3. **CI needs no workflow edit.** All six `npm run build` / `tauri build`
   jobs (ubuntu-24.04, windows-2025, macos-26 arm64, including the universal
   dmg, whose node is arm64) run `npm ci --ignore-scripts` and then the
   scripts, which call the native tsc by path. TS 7 has no install script.
   The lockfile must carry the platform packages. With npm 11.21.0 on Linux
   it records all 20 `@typescript/typescript-*` entries (`optional`, `os`,
   `cpu`, no `libc`, so the libc count doesn't move): verified. Step T2 checks that
   `linux-x64`, `win32-x64`, `darwin-arm64` and `darwin-x64` are present.
   `ci-local.sh` and `gates.sh` need no edit either: `package.json` and the
   tsconfigs count as frontend (`scripts/lib/changed.sh`), so `npm run build`
   runs. Dependabot gets an `ignore` entry for `typescript` majors (see
   step T2), so it can't propose 5→7 on the parser's copy, and one for
   `typescript-native` (unregistered name, decision 1). The alias is bumped
   by hand.
4. **Fallback: fix the code if the fix is valid on both, otherwise pin or
   revert.** A TS 7 diagnostic that 5.9 doesn't give gets a rewrite that both
   accept (T1 is the one case today). A real TS 7 false positive that can't
   be rewritten gets a minimal upstream repro and a hold, not a
   `@ts-expect-error`. Rollback is `git revert` of T2: the scripts go back to
   `tsc`, and 5.9.3 never left the lock, so CI keeps working right away. Then
   the main-tree install as in `docs/done/vite8_vitest5_migration_plan.md` §4.
   Later 7.0.x/7.1 bumps are by hand, under the same cooldown.
5. **Repo hygiene:** `privacy-reviewed-binaries.txt` doesn't change (node_modules
   isn't tracked). brand-check doesn't care (`typescript-native` spells no
   brand). No filemap row names a tsconfig or the build script. AGENTS.md's
   "`npm run build` # the ONLY type-check (tsc + …)" stays true. Add one
   clause to its Gates paragraph, after the code block: *"Its `tsc` is
   TS 7 (`typescript-native`, called by path); the `typescript` 5.9 package
   is only for typescript-eslint and editors — never bump it to 7."*
   No `docs/context/` or filemap line: no subsystem or load-bearing file
   changes. The `eslint.config.js:12` comment ("`npm run build` already runs
   `tsc`") stays correct.

## Probe (scratchpad, 2026-10-13, 24 cores, other sessions loading the box)

Run with `tsc -p <repo>/tsconfig{,.mobile}.json --noEmit`, the repo's
node_modules resolving the types:

| check | 5.9.3 | 7.0.2 |
|---|---|---|
| src (`tsconfig.json`) | 31.9 s / 39.0 s, 1.95 GB | **4.8 s** (load 14), 13.7 s (load 64), 57 s (cold, load 110); 1.54 GB; `--singleThreaded` 9.6 s |
| mobile | 6.9 s, 0.55 GB | 2.7 s, 0.41 GB |
| errors | 0 | 8: 7 × TS2882 (decision 2), 1 × TS2871 |

TS2871 "This expression is always nullish" at
`src/components/files/ProjectFilesTab.tsx:110` is a **TS 7.0.2 false
positive** (re-verified): it classifies any `a ?? null` as always
nullish. `(xs.find(f) ?? null) ?? inj` and
`(c ? xs.find(f) ?? null : null) ?? inj` both give TS2871 on 7.0.2 and
nothing on 5.9.3; `(c ? xs.find(f) : null) ?? inj` is clean on both. The
check (5.6+) is legitimate; only its `??` classification is wrong.
Nothing else differs. All of `src/__tests__` checks clean.

## Steps

Ground rules come from `docs/done/vite8_vitest5_migration_plan.md` §4. Never
start or stop Tabtivity. Never stash or reset (other sessions share the
tree). Do every lockfile write with `npx -y npm@11.21.0`, because PATH's npm
9.2 drops `libc`. Commit with explicit paths. Install with `--before=<install
day − 7 days>`.

### T0 — Entry

- That plan's **S0 is done**: `dafecadd` "fix(deps): lock vite 6.4.4 to
  match package.json" (other subject than S0 planned; the lock has vite
  6.4.4, root version 0.2.9). Not blocked on it.
- At start **and again at landing**: `git status --short package.json
  package-lock.json` is empty and no vite-plan S3/S4 lock is about to land.
  Never interleave; whichever lands second regenerates its lock from HEAD.
- `scripts/package-dev-auto.sh --status` is idle.
- **Worktree:** all work happens in `.claude/worktrees/ts7` (never
  `target/`) with its own fresh `npx -y npm@11.21.0 ci --ignore-scripts`.
  Never a symlinked `node_modules` (it silently drops the pdf.js tests):
  check `npm test`'s file and test COUNT matches the main checkout's. The
  main checkout's `node_modules` is touched exactly once, by T2's landing
  install: additive (the alias + one platform package), and before the
  commit, since the frozen dev build symlinks it and every session's
  `npm run build` needs the alias once `package.json` names it.

### T1 — Code and tsconfig edits valid on both compilers (no deps change)

- `src/components/files/ProjectFilesTab.tsx:112`: delete the inner
  ` ?? null`, nothing else (smaller than hoisting a variable):
  `? projects.find((p) => resolveProjectDirectory(p) === cwd)`.
  Behaviour is the same: `find` gives `undefined` exactly where the old
  code gave `null`, and the outer `??` falls through to `injectedProject`.
- `tsconfig.json`: add `"types": []`, `"esModuleInterop": true` and
  `"noUncheckedSideEffectImports": false`. `tsconfig.mobile.json`: add
  `"types": []` and `"noUncheckedSideEffectImports": false`.
- **Done when:** in the worktree `npm run build` (still 5.9) is green with
  zero warnings, and `node node_modules/typescript-native/bin/tsc -p
  tsconfig.json` / `-p tsconfig.mobile.json` (after T2's worktree install)
  print 0 errors. Gates: `scripts/gates.sh` (build, related vitest, lint).
  Land T1 (copy the three files to the main tree, commit) before T2. Commit
  `build(ts): tsconfigs and code ready for TS 7`
  `-- tsconfig.json tsconfig.mobile.json src/components/files/ProjectFilesTab.tsx`.

### T2 — Add the native compiler

- `package.json`:
  - `devDependencies`: add `"typescript-native": "npm:typescript@7.0.2"`.
    Leave `"typescript": "^5"`.
  - `"build"`: `node node_modules/typescript-native/bin/tsc && vite build && …`
  - `"mobile:build"`: `node node_modules/typescript-native/bin/tsc -p tsconfig.mobile.json && npm run mobile:bundle`
- `.github/dependabot.yml`, npm `ignore`: add
  `- dependency-name: "typescript"` with
  `update-types: ["version-update:semver-major"]`, plus
  `- dependency-name: "typescript-native"`, and a comment: `typescript` is
  the typescript-eslint parser's copy (peer `<6.1`); `typescript-native` is
  the TS 7 alias, bumped by hand (name unregistered on npm).
- `AGENTS.md` Gates: the one clause from decision 5.
- In the worktree: `npx -y npm@11.21.0 install --ignore-scripts
  --before=<day−7>`. Landing (vite plan §4): `--status` idle → copy the
  reviewed `package.json` + lock to the main tree → at once
  `npx -y npm@11.21.0 install --ignore-scripts` there (never `npm ci`: the
  user's window runs on it), leaving the lock byte-identical →
  `npx -y npm@11.21.0 rebuild typescript --ignore-scripts` (relinks
  `.bin/tsc` to 5.9.3, as a fresh `npm ci` has it; `readlink
  node_modules/.bin/tsc` = `../typescript/bin/tsc`) →
  `npm ls --depth=0` → commit.
- **Done when:**
  - `git diff package-lock.json` adds only `node_modules/typescript-native`
    and 20 `node_modules/@typescript/typescript-*` entries (plus the root
    `devDependencies` line). A node one-liner over the lock confirms
    `@typescript/typescript-{linux-x64,win32-x64,darwin-arm64,darwin-x64}`.
    `grep -c '"libc"' package-lock.json` ≥ HEAD's.
  - `npm ls --package-lock-only --depth=0` and `npm ls --depth=0` pass.
    `npm ls typescript` shows 5.9.3 under typescript-eslint and react-doctor,
    and has no `invalid`/`ERESOLVE` lines.
  - `node node_modules/typescript-native/bin/tsc --version` prints 7.0.2,
    and `npx tsc --version` prints 5.9.3.
  - Planting a type error in a scratch copy of a `src` file makes
    `npm run build` fail on TS 7. Revert it.
  - `npm run lint` runs (parser on 5.9), no new warnings.
  - Gates: `scripts/gates.sh --all` (zero warnings except lint; the build
    gate triggers: `scripts/lib/changed.sh` counts `package.json` and the
    tsconfigs as frontend), `scripts/privacy-check.sh`, and before the
    push `scripts/ci-local.sh --fast`.
- Commit `build(ts): type-check with TypeScript 7 (native tsc)`
  `-- package.json package-lock.json .github/dependabot.yml AGENTS.md`.
  Re-diff `package.json` right before, because the version-bump hook writes
  it.

### T3 — CI on three OSes

- Push develop (`git_push`; don't push while develop's last ci-cd run is
  red). Watch `ci_runs`/`ci_run`: "Build frontend" must pass on ubuntu,
  windows-2025 and macos-26, and `package-*` must pass too (Windows nsis,
  Linux appimage/deb, macOS universal dmg). Compare the step durations with
  the last green run.
- **Done when** develop CI is green on all three OSes and the frozen dev
  build (`package-dev-auto.sh --status`) has finished on the new deps.

## Agent steps

| agent | plan sections | files |
|---|---|---|
| 1 implementer (+ 1 reviewer) | T0–T3, decisions 1–5 | `src/components/files/ProjectFilesTab.tsx`, `tsconfig.json`, `tsconfig.mobile.json`, `package.json`, `package-lock.json`, `.github/dependabot.yml`, `AGENTS.md` |

## Verification

- **Timing, in the T2 commit message:** `/usr/bin/time -f '%e s %M KB'` for
  `npm run build` and each tsc call, before and after T2, at `uptime` load
  < 4. Expected: src ~35 s → ~5 s, mobile ~7 s → ~3 s.
- **Nothing user-visible changes.** tsc emits nothing; T1 keeps behaviour.
  No live click-through is needed, and the app is not run. The user can
  watch `npm run build`'s type-check finish in seconds. In the next frozen
  dev build, a Files tab inside a box scope should still show the member's
  git bar (the one code path T1 touches).

## Open question for the user

None blocking. Optional: report the TS2871 false positive upstream
(microsoft/typescript-go) with the two-line repro above.
