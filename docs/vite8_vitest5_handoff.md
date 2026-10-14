# Vite 8 + Vitest 5 migration — handoff

Plan: `docs/vite8_vitest5_migration_plan.md`. One section per agent step;
details stay in the session scratchpad findings notes
(`vt-findings-part1.md`, `-part2.md`).

## A1a — S1 setup, baseline B, clearMocks cost, S1a vite 8 in S

Status: **done** (2026-10-14, no commits). Findings:
`<scratchpad>/vt-findings-part1.md` (+ raw `base*.json`, `s1a*.json`,
listings, `s3-extra-*.patch`).

- Base: HEAD **78c6bb4b** (the plan's §2 says d40529e9; five dep commits
  landed since — xterm 6, TS 7 `typescript-native`, katex 0.19, pdfjs 6.4,
  minors).
- Worktrees: B = `.claude/worktrees/vt-base` (detached 78c6bb4b, hardlinked
  node_modules — never install there; holds the vite 6 build). S =
  `.claude/worktrees/vt-spike` (branch `vt-spike` at 78c6bb4b, own npm 11
  install; vite 8.3.3 + plugin-react 6.1.1 + S3 config edits **uncommitted**).
- Baseline: **825 files / 8386 tests**, all green; build 50 s, 410 files,
  already 3 chunk-size warnings.
- clearMocks on v4: **1 real-break file** (`viewers/MarkdownEnrich.test.ts`,
  asserts a module-load `mermaid.initialize` call) → adopt `clearMocks: true`.
- S1a: suite **825 / 8386 green, per-file counts identical**; build 19.5 s,
  599 files (finer chunking, total bytes ±0.1 %); all §6 checks pass; no root
  esbuild; lock +51/−1081 (`git diff --histogram`).
- Beyond S3's list (tested, patches in scratchpad): `.ts` extensions on the
  vite configs' relative imports; pdf-frame `define` + `output.intro` for
  `import.meta.url`; `source` on PostCSS nodes in
  `mobile-web/src/themeColors.ts`.

## A1b — S1b vitest 5 in S, proofs, Gate D1

Status: **done** (2026-10-14, no commits). Findings:
`<scratchpad>/vt-findings-part2.md` (+ raw `v5*.json`, `ps3`/`pb3`,
`cif-*`, `smoke*`, `s2-markdownenrich.patch`).

- Version: **vitest 5.0.0** — 5.0.1 (09-15 08:49Z) turns 30 days on
  10-15, not today. No open advisory for 5.0.0. Installed in S with npm 11,
  `--save-exact --before=2026-10-07`; no `@vitest/*` devDependency needed
  (vitest 5 bundles expect/runner/snapshot/utils; pulls `@vitest/mocker` +
  `@vitest/spy` 5.0.0). Lock vs S1a: +3 / −9 / ~9, all ≥ 7 days; one vite;
  `libc` 5; audit unchanged (Tailwind chain only). S is left with vite 8.3.3
  + plugin-react 6.1.1 + vitest 5.0.0, uncommitted.
- Suite: 7 full runs, each **825 files / 8386 tests, per-file counts
  identical to B**. Only failure: `viewers/MarkdownEnrich.test.ts` — the
  clearMocks break A1a found (3/3 alone; whole suite green with
  `clearMocks: false`). **vitest 5 itself breaks 0 files.** One flake
  (`mobile/MobileIndicator.test.tsx`, once under load in `vitest doctor`;
  green in all 7 runs and 3/3 alone on v4 and v5).
- clearMocks: default `true` confirmed; cost 1 file → adopt (decision 7).
- fsModuleCache: 5.0.0's default is already `false` (5.0.4 flips it to
  `true`); `--fsModuleCache` warm run shows no wall gain → keep `false`,
  set explicitly in S4.
- Proofs: `ci-failed-first.sh frontend` lists the failing file, `previous`
  reruns only it (JSON shape unchanged). `--changed HEAD~1` selects the same
  3 files as v4; `package.json`-only change → all 825 (outside dot paths);
  a `vi.mock`ed module's change selects the same 54 files as v4; empty
  changes and bad refs exit 0 on both versions. jsdom smoke (§7 files ×3 +
  a globals/Blob smoke test) green; `Response`/`Request` with a jsdom Blob
  body fail on **both** v4.1.11 and 5.0.0 (pre-existing; the repo never
  does it). tsc (TS 7) over `src` incl. 833 test files and mobile: exit 0,
  no TS2688 → no `@types/node`. Lint = HEAD (0 errors, 28 warnings).
- Timings (load 20–50 from other sessions): paired back-to-back v4 2:36 /
  v5 2:30; v5 cold 2:22, warm 2:46 — within noise. `vitest doctor`
  (clearMocks off so the suite is green): fsModuleCache +35 %, threads −11 %
  (noise-level; pool stays forks), vm pools fail on mermaid's `khroma` ESM.
- **Gate D1: pass** — no unexplained count difference, 1 real-break file
  (≤ 25), no §6 check open.
- For **S2**: exactly one file, `src/__tests__/viewers/MarkdownEnrich.test.ts`
  (snapshot `mermaidInitialize.mock.calls` at module top level; patch in the
  scratchpad, verified 3/3 on v5). The plan's JSON-import item is not needed
  (no warning; the 2 sites are app source).
- For **S4** beyond its list: nothing required; write `fsModuleCache: false`
  explicitly. Plan §6 nit: `why-is-node-running` stays 2.3.0 under 5.0.0.

## A2+A3 — S2 pre-fix + S3 = C1 vite 8 + plugin-react 6

Status: **landed** on local develop (2026-10-14, unpushed):
**`9aa4a721`** `test(markdown): capture mermaid's load-time initialize
before clearMocks` and **`a44e96f7`** `chore(deps): vite 8.3.3 +
plugin-react 6.1.1`, on top of `839f0772`. Worktree
`.claude/worktrees/vt-c1` (detached at 9aa4a721, own npm 11 install, C1's
edits as working-tree changes + its build output) kept for the reviewer.
Raw output in the scratchpad: `c1-head.*` (baseline suite), `c1-suite.*`,
`c1-build.*`, `c1-listing.txt`, `c1-listcmp.txt`, `msg-s{2,3}.txt`.

- **Base:** develop moved 78c6bb4b → 839f0772 (Rust deps, docs only); none
  of C1's paths changed, so the lock was built straight from HEAD's.
- **S2** (`src/__tests__/viewers/MarkdownEnrich.test.ts` only): A1b's patch.
  vitest 4.1.11, alone: 3/3 green without and 3/3 green with
  `clearMocks: true` (temporary config file, deleted; flag not committed);
  HEAD's version fails 1/14 with the flag.
- **C1 install:** `npx -y npm@11.21.0 install --ignore-scripts --save-exact
  --before=2026-10-07 vite@8.3.3 @vitejs/plugin-react@6.1.1` from HEAD's lock.
  Lock delta = A1a's exactly: CHG vite, plugin-react, `@rolldown/pluginutils`
  1.0.1; 64 drops (rollup 4 + 23 `@rollup/*`, vite 6's esbuild + 26
  `@esbuild/*`, `vite/node_modules/fdir`, `vitest/node_modules/vite`, babel
  jsx-self/source + helper-plugin-utils, `@types/babel__*`, react-refresh);
  0 adds; `git diff --histogram` +51/−1081. `typescript-native` re-sorted by
  npm (kept, decision 10).
- **Config:** S3's edits + A1a's three extras (decision 10): `.ts` import
  suffixes (5 imports), pdf-frame `define` + `output.intro` (with a comment
  on why), `themeColors.ts` `source` on the 3 created PostCSS nodes.
- **Advisories rechecked** (GitHub API, today): vite's three 10-06 advisories
  patched in 8.3.3, nothing newer; vite-plugin-react repo lists only
  plugin-rsc advisories. `npm audit --omit=dev` 0; full audit = HEAD's
  (Tailwind chain only).
- **Gates (worktree):** `npm run build` exit 0, 29.8 s, **only HEAD's 3
  chunk-size warnings**; `npm test` **825 files / 8386 tests, all green**,
  per-file counts identical to the HEAD baseline run (825 / 8386; that run
  had 2 load flakes — `MobileIndicator` (known) and `tex/BibCards`, 3/3
  green alone on vite 6); `npm run lint` 0 errors / 28 warnings (= HEAD);
  `scripts/gates.sh` all selected PASS (brand, whitespace, lint, build,
  vitest --changed); pre-commit privacy scan + gitleaks on both private
  indexes passed.
- **§6:** one vite (8.3.3; plugin-react, unplugin, vitest, mocker dedupe);
  rolldown 1.2.13, lightningcss 1.33.0, no esbuild anywhere; platform
  bindings present; `npm ls --depth=0` and `--package-lock-only` clean;
  `libc` 5 = HEAD's 5. Output listing byte-identical to S1a's except the
  pdf-frame (+48 B, the intro) and the mobile `index.js` hash, so A1a's
  >10 % table holds (all chunk re-partitioning + mobile CSS +18.7 % from
  target lowering). SW: `index.html` names `/assets/index-*.js`, 0
  placeholders, both stamped assets exist. pdf-frame: name matches, classic
  script parses, 0 `import.meta`, starts with the `currentScript` capture.
  web `index.html`: `/desktop/` entry + rolldown-runtime preload. Prefixes:
  bootstrap.css `-webkit-` 235 / `-moz-` 134, mobile 110 / 44 (A1a's
  numbers). CJS interop (vite 8 lib build under jsdom): fontkit.create,
  katex.renderToString, mermaid.initialize all work.
- **Landing:** status idle → both commits via private index + pre-commit
  hook + HEAD-unchanged check + `update-ref` → main-tree files copied in and
  `git reset -q NEW -- <paths>` → `git hook run post-commit` (each) →
  main-tree `npx -y npm@11.21.0 install --ignore-scripts`: lock
  byte-identical (sha256), `npm ls --depth=0` clean, root vite 8.3.3,
  plugin-react 6.1.1, no rollup/esbuild/nested vitest vite.
- **Gotchas:** RTK rewrites `npx vitest …` output (prints a fake "PASS
  (8386)" and swallowed a loop) — run `rtk proxy node
  node_modules/vitest/vitest.mjs`. vitest 4 has no `--clearMocks` CLI flag;
  use a temp config. In a dot-dir worktree `gates.sh`'s `vitest --changed`
  does not rerun all on a `package.json` change (A1b's flag), so the full
  suite was run separately.

## A2+A3 review

Status: **done** (2026-10-14). Verdict: **sound, one fix landed** —
**`f7f90727`** `fix(mobile): keep the PDF frame's script in strict mode on
vite 8` (on a44e96f7; `vite.pdf-frame.config.ts` +
`src/__tests__/mobile/MobilePdfFrameBuild.test.ts`). Worktree `vt-c1` now
sits clean at f7f90727. Scratch: `<scratchpad>/rev/`.

- **Bug fixed:** Rollup put `"use strict"` on an IIFE by default (vite 6's
  frame: `(function(){"use strict";…`); Rolldown's `output.strict` defaults
  to `'auto'` (only source directives) and ESM has none, so a44e96f7's frame
  ran pdf.js in **sloppy mode**. `strict: true` restores it (Rolldown puts the
  directive at the top of the file, before the IIFE; the file is alone in its
  page). No break was seen either way in a jsdom end-to-end run (see below),
  so this is the vite 6 semantics back, not a live failure.
  The new test mocks `vite`'s `defineConfig`, imports the config (through a
  variable path, as `MobilePdfFrame.test.ts` does), and pins IIFE + `strict`
  + `codeSplitting: false`, the `define` ↔ `intro` binding of
  `import.meta.url`, and the target pin. Fails without the fix (1/3).
- **Checked, fine:**
  - `import.meta.url` shim: the intro sits inside the IIFE, the minifier
    renamed the define'd identifier and every pdf.js use consistently. jsdom
    run of the real built frame (open → meta → findText) on the vite 6 frame,
    a44e96f7's and f7f90727's: identical messages, no errors, captured URL =
    the script's `src`. The frame has no Worker (main-thread
    `globalThis.pdfjsWorker`), so `document` always exists for the intro.
  - `build.target` in all four configs and applied: 0 class static blocks /
    private fields in any bundle; the frame carries Oxc's private-field
    helpers. `cssTarget` follows it, so Lightning CSS lowers to it (A1a's
    +18.7 % mobile CSS); it also adds `--lightningcss-light/dark` vars to the
    mobile `color-scheme` rules, inert (no `light-dark()` in the sources).
  - `.ts` config imports: vite 8's default `configLoader` is `'bundle'`,
    which resolves explicit extensions on every OS; no tsconfig covers the
    configs; nothing else imports them.
  - `themeColors.ts`: PostCSS's `Node` constructor copies `source`, and
    `append`/`after` turn the plain objects into `Declaration`s keeping it;
    sharing `root.source` by reference is what PostCSS's own `clone` does.
  - Lockfile (`git diff --histogram` +51/−1081): 0 adds, 3 changes (vite,
    plugin-react, `@rolldown/pluginutils`; dates confirmed with `npm view`,
    ≥ 7 days), 64 drops, one vite, no esbuild, `libc` 5; rolldown +
    lightningcss bindings for win32-x64-msvc, darwin-arm64, darwin-x64,
    linux-x64-gnu present; `npm ls --package-lock-only --depth=0` clean.
  - S2 test: equivalent, not weakened — the old assertions ran in the first
    test, so the history they saw was exactly the module-load calls the
    snapshot now holds.
  - Scope: the two commits touch only the plan's paths.
- **Gates (vt-c1, with the fix):** `npm run build` exit 0, HEAD's 3
  chunk-size warnings **plus an intermittent `[PLUGIN_TIMINGS]`** (flagged
  below); full suite **826 files / 8389 tests** green (+1 file / +3 tests);
  `npm run lint` 0 errors / 28 warnings; `scripts/gates.sh` all PASS;
  pre-commit on the private index passed. Landed by private index +
  `update-ref` (HEAD checked) + `git reset -q f7f90727 -- <paths>` in main +
  `git hook run post-commit` (declined in the fence, the window queues it).

## A4 — S4 = C2 vitest 5

Status: **landed** on local develop (2026-10-14, unpushed):
**`66f9ae39`** `chore(deps): vitest 5.0.0` and **`1b5d8d4b`** `ci: the
lock's only install script is fsevents' now`, on top of `f7f90727`.
Worktree `.claude/worktrees/vt-c2` (detached at f7f90727, own npm 11
install, both commits' edits as working-tree changes) kept for the reviewer;
`.claude/worktrees/cargo-home-c2` is a writable `CARGO_HOME` (600 MB, delete
when done). Scratch: `c2-suite.{json,log,time}`, `c2-build.log`,
`c2-gates-all.log`, `cif-c2/`, `c2-head-lock.json`, `msg-c2.txt`,
`msg-ci.txt`.

- **Version:** vitest **5.0.0** — installed 10-14 09:30 UTC, 5.0.1 turns 30
  days only on 10-15 08:49Z. Advisories rechecked (GitHub API, today): none
  for 5.0.0 (GHSA-82fw-gwwq-j7x9 fixed from 5.0.0-rc.2; the rest are
  `@vitest/browser`/UI, not installed). `npm audit --omit=dev` 0; full audit
  = HEAD's 7 (Tailwind chain only).
- **Install:** fresh worktree at HEAD, `npx -y npm@11.21.0 ci
  --ignore-scripts`, then `npx -y npm@11.21.0 install --ignore-scripts
  --save-exact --before=2026-10-07 vitest@5.0.0`; after the `engines.node`
  edit, `npx -y npm@11.21.0 install --package-lock-only --ignore-scripts
  --before=2026-10-07` (changes only the lock's root `engines`). Lock delta
  = A1b's exactly: ADD `@vitest/mocker` 5.0.0 + nested `magic-string` 1.4.3
  (under vitest and mocker); CHG vitest, `@vitest/spy` → 5.0.0,
  sourcemap-codec 1.6.0, es-module-lexer 2.3.2, expect-type 1.4.0, obug
  2.2.1, std-env 4.3.0, tinybench 6.1.4, tinyexec 1.3.0; DROP
  `@vitest/{expect,pretty-format,runner,snapshot,utils}` 4.1.11,
  vitest-nested mocker 4.1.11, `@standard-schema/spec`, pathe, tinyrainbow.
  Every changed entry ≥ 7 days old (newest magic-string 1.4.3, 10-05).
  `git diff --histogram` lock +93/−169. `libc` 5 = HEAD's.
  `npm@11.21.0 ci --dry-run` clean.
- **Config:** `package.json` `"vitest": "5.0.0"`, `engines.node`
  `^22.13.0 || ^24.0.0 || >=26.0.0`; `vitest.config.ts` `clearMocks: true` +
  `fsModuleCache: false`, each with a one-paragraph why; `.gitignore`
  `.vitest/` (next to `node_modules/`). No `@vitest/*` dep, no
  `@types/node`.
- **CI comment** (`ci-cd.yml:36-39`): now says fsevents' is the lock's only
  install script (verified: `hasInstallScript` only on `fsevents` 2.3.3).
  No other esbuild mention left in `.github/`, `scripts/` or the configs.
- **Gates (vt-c2):** `scripts/gates.sh --all` **all 10 PASS** (brand,
  whitespace, lint, 3 clippy, build, `npm test`, `cargo test --workspace`,
  daemon tests) — the Rust gates needed a writable `CARGO_HOME` (first run
  failed on the read-only `~/.cargo/registry`, see gotchas). Separate full
  suite: **826 files / 8389 tests, all green, per-file counts identical to
  f7f90727's vitest 4 run** (`rev/suite.json`), 224 s. `npm run build` exit
  0: HEAD's 3 chunk-size warnings + one `[PLUGIN_TIMINGS]` (desktop build,
  6.9 s / 91 %, vite:css) — the same intermittent notice HEAD's review builds
  printed (web); vitest doesn't touch the build. `npm run lint` 0 errors / 28
  warnings (= HEAD). One vite (8.3.3; plugin-react, unplugin, vitest,
  mocker dedupe), one vitest, no esbuild; `npm ls --depth=0` and
  `--package-lock-only --depth=0` clean; rolldown/lightningcss win32,
  darwin-arm64, linux bindings present. Privacy scan on both private indexes
  passed (pre-commit hook + `privacy-check.sh`).
- **`ci-failed-first.sh` on v5:** a temporary failing test → `frontend`
  exit 1, 827 files run, `frontend.txt` listed it (plus `TypeCheckGate`,
  which tsc-failed on the temp file's missing `it`/`expect` types — my
  file, not a regression); `previous` reran exactly those 2 files, exit 1,
  printed the `::error::` line. Temp file deleted.
- **Landing:** `--status` idle → private index from HEAD + worktree blobs →
  `git hook run pre-commit` → `commit-tree` (C2, then the ci commit on it)
  → HEAD still f7f90727 → `update-ref` → main-tree files written from the
  new commit, `git reset -q 1b5d8d4b -- <5 paths>` → `git hook run
  post-commit` (frozen build declined in the fence again; `--status` idle) →
  main-tree `npx -y npm@11.21.0 install --ignore-scripts` ("added 3,
  removed 9, changed 9"): `package.json` + lock identical to HEAD (`git diff
  --quiet`), `npm ls --depth=0` clean, root vitest 5.0.0, vite 8.3.3.
- **Gotchas:** `gates.sh --all` in the fence: cargo can't download into the
  read-only `~/.cargo/registry` (`alloc-stdlib-0.3.0.crate` missing from the
  cache) → `CARGO_HOME=<repo>/.claude/worktrees/cargo-home-c2` seeded with
  `cp -a ~/.cargo/registry/{cache,index}` + `RUSTUP_HOME=~/.rustup`, own
  `CARGO_TARGET_DIR` (7.4 GB, deleted afterwards). Bash permission rules
  refuse reading the main tree's `package-lock.json` directly (`cp`,
  `sha256sum`); `git diff --quiet HEAD -- package-lock.json` proves
  byte-identity instead. vitest 5 prints an end-of-run "Environment jsdom
  was created 826 times …" hint (`experimental.diagnostics`), informational.

## A4 review

Status: **pass, no fix commits** (2026-10-14; reviewed `66f9ae39` +
`1b5d8d4b` in `vt-c2`). Scratch: `<scratchpad>/a4rev/`.

- Config: `clearMocks` and `fsModuleCache` are top-level `InlineConfig` keys
  in 5.0.0's types and runtime (`experimental.fsModuleCache` is the
  deprecated spelling); no other key in `vitest.config.ts` is deprecated or
  ignored. `.vitest/` matches 5.0.0's default report/attachments dir.
- `engines.node` sits inside vitest 5.0.0's (`^22.12 || ^24 || >=26`) and
  jsdom's ranges; `.nvmrc` 24 and local 22.22.1 satisfy it.
- Scripts: `ci-failed-first.sh` (multi-reporter `--outputFile`, JSON
  `testResults[].status/name`), `rename-codemods/vt.sh` (`num*` totals,
  `assertionResults` keys) and `gates.sh`/`ci-local.sh` `--changed` are
  compatible with 5.0.0's reporter/CLI; no script reads JSON from stdout.
- clearMocks vacuity: full suite run twice with an `afterEach` recording
  `expect.getState().assertionCalls` per test, `clearMocks` on vs off: 8389
  tests each, no test drops to zero assertions, the 10 with fewer and 18
  with more are all `waitFor` retry counts; no `.every()` over
  `mock.calls`; the 2 `for … of mock.calls` loops and the 3 `beforeAll`
  files read only calls the test itself caused.
- Lock: `--histogram` +94/−170; one vite (8.3.3), one vitest (5.0.0), no
  esbuild, only fsevents has an install script; every changed entry
  published ≤ 2026-10-05; `libc` 5 = parent's; added `license` fields only
  on changed entries (npm 11). Per-file test counts v4 vs v5: 0 diffs.
- `ci-cd.yml`: comment-only change confirmed.

## A5a / A5b — S5 = C3 Tailwind removal

Status: not started.

## Flagged for user

- (A1a) HEAD's `package-lock.json` has **5 `libc` fields, not 34**: 19f00302
  (minor bumps) dropped all of them. npm 11 `install` does not restore them.
  Regenerate the lock with npm 11 in its own commit, or accept 5?
- (A1a) S3's exit "zero build warnings": the **baseline already prints 3
  chunk-size warnings** (desktop, mobile app, web). Raise
  `chunkSizeWarningLimit`, or treat those 3 as accepted?
- (A1a) The `themeColors.ts` fix is a source edit in C1, which the plan
  scoped to `package*.json` + configs: OK to include?
- (A1a) npm moves `typescript-native` below `typescript-eslint` in
  package.json (alphabetical order). Keep npm's order?
- (A1b) Pre-existing, both vitest 4 and 5: in a checkout whose path has a
  dot directory (every agent worktree under `.claude/worktrees/`),
  `vitest --changed` does not treat a `package.json`-only change as
  "rerun everything" (picomatch `**` skips dot dirs; it selects only the 42
  files importing `package.json`). Main checkout and CI are fine. Fix later
  (e.g. `forceRerunTriggers` with absolute paths), or accept?
- (A1b) vitest 5.0.0 (like 4.1.11) exits 0 on `--changed <bad-ref>`; 5.0.4
  fails the run. Only matters for a mistyped `scripts/gates.sh` base.
- (A2+A3) Frozen dev build: the post-commit hook declines inside the agent
  fence ("the Tabtivity window queues it", via the dev-build chip's poll);
  `package-dev-auto.sh --status` from the fence still reads `idle`, so the
  queued build on a44e96f7 could not be confirmed here — check the chip.
- (A2+A3) The running window's dev server keeps vite 6 in memory, with main's
  node_modules now on vite 8.3.3; it picks vite 8 up only when the user
  restarts it (§4). Then run the §8 live checks.
- (A2+A3) The post-commit hook reported the phone's embedded PWA as stale
  (sidecar serves `index-l3cFopwF.js`) — predates these commits.
- (A2+A3 review) **New intermittent build warning** missed by A1a and A2+A3
  (their grep for "warn" doesn't match it): Rolldown's `[PLUGIN_TIMINGS]`
  "JavaScript callbacks ran for 8–10 s of this build (92 %) … plugin
  vite:css transform (7 calls)" on the desktop and/or web build. Seen in
  A1a's `s1a-build.log` (desktop + web) and in both review builds (web), not
  in `c1-build.log`; vite 6 never printed it. The mobile build (own PostCSS,
  no Tailwind) never shows it, so Tailwind's PostCSS is the likely cost.
  Re-check after C3; if it stays: `build.rolldownOptions.checks.pluginTimings:
  false` in `vite.config.ts` + `vite.web.config.ts`, or accept it?
- (A2+A3 review) `.github/workflows/ci-cd.yml:36-39`'s comment says the
  lock's only install scripts are esbuild's and fsevents'; since C1 only
  fsevents has one. Stale comment; fix with S6 or the next CI edit?
  → **Done by A4** in `1b5d8d4b` (comment only).
- (A4) Frozen dev build for `66f9ae39`/`1b5d8d4b`: the post-commit hook
  declined inside the fence again and `--status` reads `idle` — check the
  dev-build chip that the window queued a build on 1b5d8d4b.
- (A4) The running window's dev server and any open vitest watcher keep
  their in-memory modules; main's node_modules is now vitest 5.0.0. A
  `npm test` in main runs v5 from now on (clearMocks default on).
- (A4) Intermittent `[PLUGIN_TIMINGS]` notice seen again (desktop build this
  time) — unchanged by C2; still the A2+A3 review's open question (re-check
  after C3).
- (A4) vitest 5.0.1 becomes eligible 10-15 08:49Z; 5.0.2–5.0.4 carry the
  jsdom Blob, `--changed` bad-ref and fsModuleCache fixes. A later bump only
  changes the pin — `fsModuleCache: false` is already explicit.
