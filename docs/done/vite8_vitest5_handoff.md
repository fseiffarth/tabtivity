# Vite 8 + Vitest 5 migration — handoff

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Plan: `docs/done/vite8_vitest5_migration_plan.md`. One section per agent step;
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

## A5a — S5 baseline (no commit)

Status: **done** (2026-10-14, no commits, no tracked edits besides this
section). Baseline at **develop `5af871a9`** (first taken at 1b5d8d4b, then
redone: 9 commits landed meanwhile, two touching `src/styles`, and the
utility set changed — `select-all` came back via a new comment). Worktree
`.claude/worktrees/tw-base` (detached 5af871a9, hardlinked node_modules —
never install there; A5b needs its own worktree + npm 11 install, as A4).
Artifacts in `<scratchpad>/tw-baseline/` (12 MB; `<scratchpad>` =
`<scratchpad>`):

- **Built CSS** `css/`: `before.css` (desktop `dist/` bootstrap bundle,
  656,547 B), `before-web.css` (`web-dist/`, differs only in `/desktop/`
  font URLs; probe-identical), the lazy chunks `before[-web]-{TerminalView,
  markdownEnrich,GitHistory,ImageAnnotator}.css` (no Tailwind in them),
  `before-mobile-index.css` (record only). Build is deterministic (rebuild
  → byte-identical bundles).
- **`css/before[-web].stripped.css`** = the bundle minus what S5 drops by
  design, re-serialised one rule per line — `after.css` should equal it up
  to formatting. Made by `scripts/strip-tailwind.cjs <wt> tw/utilities.json
  in out` (aborts if a utility-named rule sits outside the block); run it
  with `--normalise-only` first on `after.css` so both sides share format,
  then `diff`. Removed: 66 top-level nodes (61 selectors, `container`'s 5
  `@media` included) + 103 `--tw-*` declarations (only the 3 default rules
  `*,:before,:after` / `::backdrop` / `:before,:after{--tw-content}`; no app
  rule declares or reads a `--tw-` var — 0 in every chunk).
  `-webkit-`/`-moz-` declarations: 125 in `before.css`, 123 after stripping
  (the two dropped are the `select-all` and `backdrop-filter` utilities'),
  so A5b's prefix check compares against the stripped file.
  Note: Lightning CSS (build.target pin) expands preflight's `html`
  `font-family` with `-apple-system,…,Helvetica Neue` (system-ui polyfill)
  and splits `button,input:where([type=button])…` into 4 rules — minifier
  output, identical once `reset.css` carries the same source.
- **Tailwind output** `tw/`: `tw-base.cli.css` / `tw-utilities.cli.css`
  (`npx tailwindcss -c tailwind.config.js -i … -o …`, 555 / 316 lines;
  the CLI runs autoprefixer itself), and via `scripts/emit-tailwind.cjs`
  the same through PostCSS: `*.raw.css` (tailwindcss plugin alone — what
  `reset.css` should contain) and `*.prefixed.css` (+ autoprefixer, as the
  build ran it; rule-for-rule equal to the CLI output).
- **Frozen preflight** (step 4): `tw/preflight-table.json` — 37 rules / 79
  declarations in source order, `--tw-*` removed, `theme()` resolved as
  emitted (`border-color: #e5e7eb`, sans/mono `font-family` stacks,
  `font-feature-settings`/`font-variation-settings: normal`, placeholder
  `#9ca3af`). Selector key = postcss `rule.selectors.join(", ")` — use the
  same normalisation in `ResetParity.test.ts`. **Paste-ready:**
  `tw/ResetParity.expected.ts` (`EXPECTED_PREFLIGHT`). The 103 `--tw-*`
  declarations (51 + 51 + `--tw-content`) are listed separately in
  `tw/preflight-tw-vars.json`; `preflight-table.prefixed.json` is the
  autoprefixed variant (reference only). 3.4.19's `preflight.css` carries no
  modern-normalize notice (only the `! tailwindcss v3.4.19 | MIT License`
  banner; copyright line in `node_modules/tailwindcss/LICENSE`) — the plan's
  "(and modern-normalize's)" has nothing to copy.
- **Utilities: 54 + 7 `!` twins** at 5af871a9 (= the plan's list;
  `select-all` was absent at 1b5d8d4b). `tw/utilities.json` has every rule.

**Triage (S5 step 2).** Method: `scripts/scan-classes.cjs` walks the TS AST
of all 761 `src/` files + `index.html`, records every string literal /
template chunk / JSX text token equal to a utility name with its syntactic
role (`triage/scan.json`, per-name counts `triage/triage-counts.json`);
`scripts/scan-dynamic.cjs` takes every non-literal className / `classList` /
`.className=` / `setAttribute("class")` operand that lands as a standalone
token, follows it through const initialisers, `push`es and function
returns, and resolves its value set with the type checker
(`triage/dynamic.json`): **0** can carry a utility name (14 string-typed
leftovers checked by hand: frame/bar classes, tones, `tok-*`, mail
priority `important|urgent`, state classes). HTML-in-strings: 7 `class="${…}"`
templates, all prefixed or fixed. Third-party DOM: `scripts/
scan-lib-strings.py` over mermaid (+ chunks, dagre-d3-es, roughjs, d3-axis,
cytoscape), KaTeX, pdf.js, xterm + addons, uqr (`triage/lib-*.txt`).
Totals: **relied-on 0**; **app collisions 2** (both fully overridden);
**third-party collisions 7** (2 not overridden → Flagged); **unused 45 +
7 twins**.

| selector (Tailwind sets) | verdict | evidence |
|---|---|---|
| `inline` (display:inline) | collision, overridden | `BoxScopeChip.tsx:477,532` `className="inline"` → `PillStatusBars.tsx:104` `<span class="pill-status-bars inline">`; `.pill-status-bars{display:flex}` (`projects-tabs.css:1592`, equal specificity, later) wins; `.pill-status-bars.inline` (:637) sets only position/flex/max-width. Probe: identical. Other hits: markdown/tex `kind:"inline"`, highlight keywords |
| `static` (position:static) | collision, overridden | `PillStatusBars.tsx:114` `${cls} static` → `.pill-status-bar{position:relative}` (:1630) wins; `.pill-status-bar.static` (:645) sets no position. Probe identical. Others: highlight.ts keyword sets, style values |
| `visible` (visibility:visible) | **3rd-party collision, NOT overridden** | xterm 6 scrollbar `visible scrollbar vertical` (VS Code scrollable element); `xterm.css` `.xterm .xterm-scrollable-element > .visible` sets opacity/background/transition/z-index, no visibility. Inside a `visibility:hidden` ancestor — `.center-panel.moving .pane-layer` (`subwindows.css:194`), `.detached-center.moving .pane-layer` (`base.css:183`), i.e. during a window move — the terminal's scrollbar stays painted. Probe `xterm-scrollbar-visible-in-moving`: visible→hidden, 144 px. App strings: style values, compare (`customScrollbar.ts:584`), prose |
| `invisible` (visibility:hidden) | **3rd-party collision, NOT overridden** | xterm `invisible scrollbar vertical fade`; `xterm.css` gives opacity:0 + pointer-events:none + `.fade` 800 ms opacity transition. Tailwind hides it at once, so xterm's fade-out never shows. At rest pixel-identical (probe 0 px; visibility hidden→visible). App: `beamer.ts:36` TeX command list |
| `shadow` (box-shadow via --tw) | 3rd-party collision, overridden | xterm shadow nodes `shadow[ top-left-corner][ top][ left]`: base rule `display:none`; every shown variant gets xterm's own box-shadow at (0,4,0); xterm passes `useShadows:!1` anyway. Probe: box-shadow differs only on the `display:none` node |
| `block` (display:block) | 3rd-party collision, no rendering effect | mermaid block diagram `<g class="block">`: SVG `g` renders the same (probe 0 px). App: option value `"block"` (`FileViewerPane.tsx:6497`, `ProjectFilesSettings.tsx:518`), yaml `ScalarStyle`, style values |
| `grid` (display:grid) | 3rd-party collision, no rendering effect | mermaid gantt `<g class="grid">` (probe 0 px). App: viewer mode `"grid"` (`FileViewerPane.tsx:7680–7815`, never a class), `role="grid"` (attribute), deck icon key |
| `border` (border-width:1px) | 3rd-party collision, no rendering effect | mermaid quadrant `<g class="border">`: SVG paints no CSS border (probe 0 px). App: CSS comment in `SYSMON_CSS`, prose |
| `transition` (150 ms transitions) | 3rd-party collision, no rendering effect | mermaid state edges `path.transition` (static SVG; probe 0 px). App: tests only |
| `container` | unused | 92 i18n prose, project tier value `"container"` (`ProjectDialog.tsx:305–1439`) |
| `collapse` `fixed` `absolute` `relative` `sticky` `inline-block` `flex` `break-all` `line-through` | unused | inline-style values (`position:"fixed"`, `display:"flex"`, …), compares (`customScrollbar.ts:583`), highlight keywords, CSS text in `SYSMON_CSS`, prose (`scaffold.ts:150`) |
| `hidden` | unused | style values ×17, `visibilityState` compares, localStorage values (`PromptChart.tsx:920`, `PdfPresentApp.tsx:79`), `dataset.steerPointer` (`SteeringLegend.tsx:150`), prose; pdf.js toggles `.hidden` only in editor classes (FreeTextEditor, editToolbar) — the app mounts canvas + `TextLayer` (whose only class is `markedContent`) |
| `table` `table-cell` `table-row` `list-item` | unused | viewer kind `"table"` (`fileUtils.ts:219,233,360`), TeX env names, odt.ts XML `localName` compares, `.reader-body table` element selectors in CSS strings |
| `contents` `resize` `rounded` `filter` `ring` `blur` `italic` `transform` | unused | lesson id `"contents"`; `"resize"` events + drag kinds; corners setting `"rounded"` (→ CSS vars, `settings.ts:329`); mail priority source `"filter"`; `penCursor("ring")`; `"blur"` events; style values |
| `isolate` `shrink` `flex-wrap` `overflow-scroll` `truncate` `grayscale` `backdrop-filter` `select-all` `border-collapse` | unused | no string use: identifier (`WindowControls.tsx:65`), comments (`TimeFieldCore.tsx:140` select-all, `TableView.tsx:285`, `TabBar.tsx:459`), CSS text (`browser.ts:177`, `SystemMonitorPane.tsx:1337`) |
| `m-1` `w-1` `w-2` `w-7` `grow` `pr-1` `uppercase` `lowercase` `ordinal` `invert` `underline` `outline` | unused | test files only (+ prose / xterm cursor-style option values; KaTeX 0.19 uses `katex-underline`) |
| `[path:line]` (`path: line`) | unused | `scaffold.ts:152` string `[path:line](./path:line)` |
| `!container` `!visible` `!inline` `!table` `!hidden` `!ring` `!filter` | unused | JS negations (`CenterPanel.tsx:1681` `!container`, `sleepWhenHidden.ts:38` `!hidden`, …) |

So the plan's step-2 claim holds for app code (only `inline`/`static`, 3
sites, both overridden); it missed third-party DOM: xterm's scrollbar uses
`visible`/`invisible`/`shadow`, mermaid's SVG `block`/`grid`/`border`/
`transition`. Mermaid diagrams may also carry user `classDef` names — user
content, out of scope.

**Probe** (`probe/`): `run-probe.sh <out-prefix> <main.css> [chunk.css …]`
→ `<prefix>-{main,controls}.{json,png}`; `diff.py <prefixA> <prefixB>`
(exit 1 on any preflight/collision/root difference or a pixel change
outside the thirdparty/control sections). The fence hides the X and Wayland
sockets, so `run-probe.sh` always starts a private GTK3 **broadwayd**
(scratch runtime dir, 127.0.0.1, killed on exit; plan env vars set) and
`probe.py` pins the screen to 96 dpi (broadway reports −1 → WebKit scaled
CSS px by 1e6). `fixture-main.html`: 97 preflight probes (pseudo-elements
`::before/::after/::placeholder/::first-line` included) + html/body, the box-chip-menu rows with
`pill-status-bars inline` / `pill-status-bar … static` in their real
parents, xterm scrollbar/shadow nodes (plain, fading, and inside
`.center-panel.moving .pane-layer`), mermaid `g.block/grid/border` +
`path.transition`; 418 computed properties each + `--tw-*` vars.
`fixture-controls.html`: one element per emitted utility (diffs expected).
Baseline: `probe/results/before-*` (desktop) and `before-web-*` — identical
to each other and to a rerun (0 px, 0 props). **Preview:**
`probe/results/preview-stripped-*` ran on `before.stripped.css` (= the
expected `after.css`): preflight + collision **identical** (0 px outside
thirdparty), thirdparty differs exactly as the table says
(`preview-stripped.diff.txt`). A5b: rerun with
`TMPDIR=<scratchpad>/tw-baseline probe/run-probe.sh probe/results/after
<after.css> css/before-TerminalView.css` (TerminalView chunk = xterm.css,
unchanged by S5; or the after chunk) and `diff.py probe/results/before
probe/results/after`.

**`[PLUGIN_TIMINGS]`**: 0 in 4 full builds at 1b5d8d4b, 3 in 2 builds at
5af871a9 (desktop 11.0 s of 11.8 s, web 7.6/8.3 s and 7.5/8.2 s, 91–93 %),
always `plugin vite:css transform (7 calls)`, never mobile/pdf-frame. Tailwind
is the likely cost: PostCSS over the inlined `src/styles` = 0.75 s with
autoprefixer alone, 13.0 s cold / 1.1 s warm with Tailwind (content scan of
`src/**` incl. tests). Logs `before-build{,-2}.log`. Desktop/web "built in"
7.1–14.2 s. If it survives C3, rolldown 1.2.13 calls the switch
`checks.bundlerTimings` (`pluginTimings` is deprecated).

## A5b — S5 = C3 Tailwind removal

Status: **landed** on local develop (2026-10-14, unpushed):
**`c106e375`** `chore(deps): remove Tailwind; vendor its preflight`, on
`daa7a31b`. Worktree `.claude/worktrees/tw-c3` (detached at daa7a31b, own npm
11 install, the commit's edits as working-tree changes + its build output)
kept for the reviewer. Scratch: `<scratchpad>/c3/` (`css/after*.css`,
`after*.norm.css`, `probe/after*`, `head-suite.*`, `c3-suite.*`,
`after-build*.log`, `gates.log`, `lint.log`, `lockcheck.cjs`, `msg.txt`).

- **Base:** daa7a31b; since A5a's 5af871a9 only Rust/docs changed (nothing
  under `src/`, `mobile-web/`, `index.html`, configs, `package*.json`), so
  A5a's `before*.css` stood without re-deriving.
- **Files (17):** new `src/styles/reset.css`; `src/styles/{index,base,
  browser-print-tex}.css`; `package.json`, `package-lock.json`,
  `postcss.config.js` (autoprefixer only), `tailwind.config.js` deleted;
  `vite.mobile.config.ts` comment; `DOCUMENTATION.md` styling row; one word
  each in `docs/guide/building.md` and `docs/README.tex` (stack lists still
  said "Tailwind CSS"); tests: the three new ones + `CursorPacks.test.ts` +
  `helpers/cssCorpus.ts`. No TSX touched. No filemap row (the map has no
  `src/styles`/config rows; the plan says add none).
- **reset.css:** `node_modules/tailwindcss/src/css/preflight.css` 3.4.19
  byte-for-byte except the 5 `theme()` values (taken from A5a's
  `tw-base.raw.css`) and the dropped `::before,::after{--tw-content:''}`
  rule; the `*/::backdrop` `--tw-*` defaults aren't in preflight.css
  (Tailwind emits them separately), so nothing to drop there. Header says
  why, then Tailwind's copyright + full MIT permission text, then the
  upstream `! tailwindcss v3.4.19 | MIT License` banner. First `@import` in
  `index.css` (header updated); `base.css` loses the three `@tailwind` lines,
  header says the reset lives in reset.css and no utilities exist.
- **Utilities:** none re-homed (A5a triage, decision 12).
- **Choice — `browser-print-tex.css`:** `.browser-btn` declared
  `white-space: nowrap` twice (03afe42e). Tailwind 3's
  `collapseDuplicateDeclarations` pass ran over the whole sheet and kept the
  last one; without it Lightning CSS emitted both, the only diff vs
  `before.stripped.css`. Dropped the first copy → output identical.
- **Choice — `CursorPacks.test.ts`:** its "no bare `cursor: pointer`"
  invariant now sees the reset's `button,[role="button"]{cursor:pointer}` and
  `:disabled{cursor:default}`. These were in every build before (Tailwind
  emitted them); the test just never saw them. `readAppStylesheet()` gained
  `{ exclude: [...] }` (throws on a name index.css doesn't import);
  CursorPacks excludes `reset.css`, with a comment. See Flagged.
- **Tests (`src/__tests__/theme/`):**
  - `NoTailwind` (4): no `@tailwind`/`@apply`/`@config`/`theme(`/`screen(`/
    `--tw-` in any CSS under `src/` + `mobile-web/src/` (comments stripped;
    the walk must find reset/base/mobile style.css); no `tailwindcss` /
    `@tailwindcss/*` in any `package.json` dep field; no
    `tailwind.config.{js,cjs,mjs,ts,cts,mts}`; `postcss.config.js` names
    autoprefixer and no tailwind.
  - `ResetParity` (4): A5a's `EXPECTED_PREFLIGHT` pasted verbatim; reset.css
    parsed with `postcss.parse` must equal it exactly (rules, order,
    declarations, values; `!important` would show); no at-rules or nesting;
    MIT notice present; `index.css` imports `./reset.css` first, then
    `./base.css`, once.
  - `FormerUtilities` (3): walks every non-test `src/` file with the
    TypeScript AST (+ `index.html`). Class contexts: `className`/`class`
    attributes, class-named props/vars, `classList.*`, `.className =`/`+=`,
    `setAttribute("class",…)`, `clsx`-style calls, `[…].join`, and
    `class="…"` in any string. A token that is one of the 54 names needs a
    selector where it stands alone in its compound, or must be in
    `KNOWN_COLLISIONS` (`inline` → BoxScopeChip.tsx /
    `.pill-status-bars.inline`; `static` → PillStatusBars.tsx /
    `.pill-status-bar.static`, each with a comment) and used only in the
    listed files. A second test fails if an allowlisted collision is no
    longer used or its compound rule is gone. Stricter than the plan
    (compound alone would let a new `className="inline"` pass anywhere).
    ~1 s.
  - **Fail-proofs** (each red, then reverted, then green): `@tailwind base`
    re-added to base.css → NoTailwind red; `--tw-ring-color` in
    `mobile-web/src/style.css` → red; placeholder `#9ca3af`→`#9ca3ae` →
    ResetParity red; `summary` rule removed → red; `className="inline
    truncate"` → FormerUtilities red (`truncate at BoxScopeChip.tsx:477`);
    `inline` added in PillStatusBars.tsx → red (outside allowlist);
    `.pill-status-bar.static` renamed in CSS → red. (No re-homed rule exists
    to remove.)
- **Lockfile:** `npx -y npm@11.21.0 uninstall --ignore-scripts
  --before=2026-10-07 tailwindcss` from HEAD's lock. `git diff --histogram`
  +0/−747, pure deletions: **58 entries dropped, 0 added, 0 changed** (only
  the root's devDependencies line). `lockcheck.cjs` re-resolves HEAD's lock
  without tailwindcss: the dropped set equals the unreachable set except root
  `jiti` 1.21.7, reachable only as an *optional* peer of eslint/vite (correct
  to drop; react-doctor keeps its nested `jiti` 2.x). One vite (8.3.3), one
  vitest (5.0.0); rolldown + lightningcss win32/darwin-arm64/linux bindings
  present; no esbuild; fsevents the only install script; `libc` 5 = HEAD's.
  `npm ls --depth=0`, `--package-lock-only`, `ci --dry-run` clean.
  **`npm audit` (full): 0 vulnerabilities** (HEAD: 7, braces chain +
  postcss-selector-parser, all via tailwindcss).
- **Build output:** `after.css` (desktop bootstrap, 649,312 B) and
  `after-web.css`, normalised with A5a's `strip-tailwind.cjs
  --normalise-only`, are **byte-identical** to `before[-web].stripped.css`.
  Lazy chunks (TerminalView, markdownEnrich, GitHistory, ImageAnnotator;
  desktop + web) and the mobile `index.css` byte-identical to A5a's.
  Prefixed declarations: every `-webkit-`/`-moz-` declaration in `before.css`
  is in `after.css` except the 3 inside dropped utilities (`.select-all`,
  `.backdrop-filter`, `.transition`'s property list); 131 → 128 per bundle.
- **Probe** (`run-probe.sh` on after.css + the after TerminalView chunk,
  desktop and web; `diff.py` vs `before` / `before-web`): **exit 0**, 125/125
  main + 63/63 control probes, **0 preflight/collision/root differences, 0 px
  outside thirdparty/control**. Main diffs only on: xterm
  `scrollbar-invisible` + its slider (visibility hidden→visible),
  `scrollbar-visible-in-moving` + its slider (visible→hidden; the **144 px**,
  bbox (202,911)–(206,947)) — decision 12; xterm `shadow` (box-shadow on the
  `display:none` node); mermaid `g.block`/`g.grid` (display),
  `g.border` (border widths), `path.transition` (transition) — no pixels.
  116 elements change only `--tw-*` vars. The diff text is identical to
  A5a's `preview-stripped.diff.txt`; web = desktop. PNGs:
  `probe/after{,-web}-{main,controls}.png` + `-pixeldiff.png`.
- **`[PLUGIN_TIMINGS]`: gone** — 0 in 4 builds (3 full `npm run build` +
  the gates build) vs 3 in A5a's 2 baseline builds. Desktop "built in"
  1.2–1.7 s (was 11.9 s), web 1.25–1.65 s (was 8.4 s); full `npm run build`
  ~15 s wall. No `checks.pluginTimings` switch needed.
- **Gates (tw-c3):** `npm run build` exit 0, **only HEAD's 3 chunk-size
  warnings**; full suite **832 files / 8427 tests green** = HEAD's **829 /
  8416** (same-day run in tw-base, whose tests equal daa7a31b's) **+ 3 files
  / +11 tests**, every other file's count and status identical; `npm run
  lint` 0 errors / 28 warnings (= HEAD); `scripts/gates.sh` all 5 selected
  PASS (brand, whitespace, lint-fe, build, vitest --changed);
  `scripts/brand-check.sh` PASS; `git diff --check` clean; pre-commit
  (privacy scan + gitleaks) on the private index passed.
- **Landing:** `--status` idle → private index from daa7a31b + worktree
  blobs (`--force-remove tailwind.config.js`) → `git hook run pre-commit`
  → `commit-tree` → HEAD still daa7a31b → `update-ref` → main-tree files
  written from c106e375 (none of the 17 paths had foreign edits; another
  session's uncommitted `src/styles/subwindows.css` etc. untouched) → `git
  reset -q c106e375 -- <17 paths>` → `git hook run post-commit` (declined in
  the fence again; `--status` idle) → main-tree `npx -y npm@11.21.0 install
  --ignore-scripts`: `package.json` + lock identical to HEAD (`git diff
  --quiet`), `npm ls --depth=0` clean, `node_modules/tailwindcss` gone, vite
  8.3.3 / vitest 5.0.0, audit 0.
- **Gotchas:** `strip-tailwind.cjs` needs an absolute worktree path
  (`createRequire`). The CursorPacks hit only showed up because the reset
  now sits in the corpus — any corpus invariant about element selectors may
  meet preflight the same way (none else did: all 16 corpus-reading test
  files green).

## A5b review

Status: **pass, no fix commits** (2026-10-14; reviewed `c106e375` in
`tw-c3`, whose tree equals the commit). Scratch: `<scratchpad>/rev/`.

- Reset: `postcss.parse` of `reset.css` vs A5a's raw `tw-base.raw.css`
  (`--tw-*` dropped, empty rules skipped): 37 = 37 rules, 0 differences.
  Textual diff vs `tailwindcss/src/css/preflight.css` 3.4.19: only the
  banner, the 5 `theme()` values and the dropped `--tw-content` rule. MIT
  permission text equals Tailwind's `LICENSE` word for word. The test's
  `EXPECTED_PREFLIGHT` equals A5a's `ResetParity.expected.ts`.
- Cascade: `base.css` was `index.css`'s first import and `@tailwind base`
  its first statement, so nothing ever preceded the preflight; the order is
  unchanged. Built desktop/web bootstrap CSS (normalised) byte-equal to
  A5a's stripped baselines; all 8 lazy chunks and the mobile `index.css`
  byte-equal; reset present in desktop + web bundles, absent from
  `mobile-dist` (pdf-frame imports no CSS).
- Tailwind's `collapseDuplicateDeclarations` only ever dropped exact
  same-value duplicates (different values collapse only when both carry a
  unit): app CSS's only other in-rule duplicates are 10 `overflow: hidden →
  clip` fallbacks, never collapsed. `.browser-btn`: same computed value.
- Tests: own fail-proof (reset `75%`→`76%`, `@apply` in `QuickOpen.css`,
  `"truncate"` in a conditional inside `PillStatusBars`' template class) →
  exactly the 3 expected reds, then restored. No vacuous walk (file-count /
  `toContain` guards); paths are built with `/` by the tests themselves and
  passed to `node:fs`, fine on Windows. CursorPacks' `reset.css` exclusion
  keeps its old coverage exactly: it read `base.css`'s source, where the
  preflight was a `@tailwind base` directive, so it never saw those cursors.
  The other 11 corpus readers' patterns can't be satisfied by the reset.
- Lock: package entries 58 dropped / 0 added / only root changed; an
  independent reachability walk (optional peers excluded) matches the
  dropped set exactly. `postcss ^8` + `autoprefixer ^10` still direct.
- Docs/scope: accurate; no filemap rows exist for the touched files; no
  Tailwind left in tracked files outside plan docs and an `ollama.rs`
  comment about model output.

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
- (A5a) **Tailwind leaks onto xterm's scrollbar** (third-party DOM, missed by
  the plan's triage). `.invisible{visibility:hidden}` cuts xterm's 800 ms
  fade-out to an instant hide; `.visible{visibility:visible}` keeps a
  terminal's scrollbar painted while `.center-panel.moving .pane-layer` /
  `.detached-center.moving .pane-layer` hide the pane layer during a window
  move (probe: 144 px). Per S5 step 2 the rule is "keep the leaked
  declarations under our own selector and flag" — e.g.
  `.xterm .xterm-scrollable-element > .scrollbar.invisible{visibility:hidden}`
  (+ the `.visible` twin) — or drop both, which restores xterm's own
  behaviour and fixes the window-move glitch. Keep or drop?
- (A5a) Mermaid SVG nodes `g.block`, `g.grid`, `g.border`, `path.transition`
  get Tailwind declarations that change their computed style but not a
  pixel (SVG ignores display/border on `g`; the diagram is static). Drop
  them without re-homing (A5a's recommendation), or keep under `.md-mermaid`?
- (A5b) **The vendored reset's bare cursors ignore a cursor pack** — and
  always did (Tailwind emitted the same rules): `button, [role="button"]
  { cursor: pointer }` and `:disabled { cursor: default }`. With a pack
  active, a `<button>` whose own app class sets no cursor shows the system
  pointer, not the pack's. CursorPacks.test.ts now excludes reset.css
  instead of failing. Fix (behaviour change, needs a live look): a
  `cursors.css` rule such as `:where(:root[data-cursor]) button { cursor:
  var(--cur-pointer, pointer) }` (+ `:disabled` → `--cur-default`), with
  specificity kept at or below app classes. Do it, or accept?
- (A5b) The running window's dev server still holds Tailwind's PostCSS
  plugin in memory, while main's `node_modules/tailwindcss` and
  `tailwind.config.js` are gone and `base.css`/`index.css` hot-reload
  without `@tailwind`. Until the user restarts it, expect possible Tailwind
  warnings ("content option missing") or a CSS reload error in the dev
  console. Restart dev, then run the §8 "After C3" checks — including a
  terminal's scrollbar: it now fades out over xterm's 800 ms and hides while
  a window is being moved (decision 12).
- (A5b) Frozen dev build for c106e375: post-commit declined inside the fence
  again (`--status` idle). Check the dev-build chip.
- (A5b) `docs/root_cleanup_plan.md` step 3 ("Tailwind config into
  `src/styles/`") is now moot: only `postcss.config.js` (autoprefixer)
  remains. Not edited (plan doc).


## Final review

Status: **pass, no fix commits** (2026-10-14; develop `0f2bb2ee`, fresh
worktree `.claude/worktrees/final-rev` with its own `npx -y npm@11.21.0 ci
--ignore-scripts`). Scratch: `<scratchpad>/final/` (`gates-all.log`,
`ci-local.log`).

- **Integration at HEAD:** only the six migration commits touch
  `package*.json`; no config, `src/styles` or `index.html` change after
  c106e375 (0f2bb2ee renames one test). `npm ci` clean; `npm ls --depth=0`
  and `--package-lock-only --depth=0` clean; one vite (8.3.3), one vitest
  (5.0.0), plugin-react 6.1.1; no tailwindcss / esbuild / rollup in the lock
  or `node_modules`; fsevents the only install script; rolldown +
  lightningcss win32-x64-msvc / darwin-arm64 / linux bindings present;
  `libc` 5; lock root version = `package.json` 0.2.9. `npm audit` (full and
  `--omit=dev`): 0. The main tree's uncommitted edits add no Tailwind syntax
  or utility-named class.
- **Leftovers** (`rg -i 'tailwind|esbuild|rollupOptions|inlineDynamicImports'`
  over tracked files minus plan docs/lock/reset/theme tests): only correct
  prose (DOCUMENTATION.md:65, base/index.css headers, the pdf-frame config's
  "Rollup did X" history, an `ollama.rs` comment on model output), plus the
  two nits flagged below. `.github/`, `scripts/`, configs: none. Filemap rows:
  none name the touched files (the pdf-frame row's "classic IIFE" is still
  true). No i18n or UntestedTag need (toolchain, CSS reset and tests only).
- **Cross-OS tests:** `.gitattributes` `* text=auto eol=lf` pins LF on every
  checkout, so `NoTailwind`/`ResetParity`/`FormerUtilities`/cssCorpus string
  reads see `\n` on Windows too; all paths are relative, built with `/` and
  compared as such (never from `path.join`); `MobilePdfFrameBuild` imports
  the config via a relative specifier and mocks `vite`. No OS-specific
  assumption found.
- **Backend:** none of the six commits touches `src-tauri/`, `src-core/`,
  `src-gateway/` or `src-serverd/`; the Windows/macOS cross-checks ran anyway
  as part of `ci-local.sh` (green).
- **`scripts/gates.sh --all`:** 10/10 PASS (brand, whitespace, lint-fe 0
  errors / 28 warnings = HEAD, clippy ×3, build, `npm test`, `cargo test
  --workspace`, daemon tests). Rust gates with `CARGO_HOME=.claude/worktrees/
  cargo-home-c2`.
- **`scripts/ci-local.sh` (full):** 22/23 PASS, 1 SKIPPED — gitleaks is not
  installed in the fence (CI's secrets job runs it). Frontend suite **832
  files / 8427 tests** green (= A5b's count; 0f2bb2ee only renames a file);
  build: HEAD's 3 chunk-size warnings only, no `[PLUGIN_TIMINGS]`; Windows
  clippy + check and macOS check green; daemon `ldd` clean; drift guard ok.
- `scripts/privacy-check.sh origin/develop HEAD` (48 commits): pass.

### Flagged for user (final review)

- `mobile-web/src/shellAssets.ts:6` says loading the vite config "drags
  esbuild into a jsdom test"; on vite 8 it is Rolldown/Lightning CSS. The
  reason still holds; comment wording only — fix on the next edit there?
- `docs/root_cleanup_plan.md` step 3 (move `tailwind.config.js`) is moot
  (A5b's item, still open): mark it done/obsolete in that plan?
- gitleaks was unavailable locally in every step's checks; the first push's
  CI `secrets` job is its only run over this range.
- Frozen dev builds for the range could not be confirmed from the fence
  (`--status` idle; `target/` unreadable) — check the dev-build chip before
  pushing, then S6: push, three-OS CI, §8 live checks.
