# Vite 8 + Vitest 5 migration + Tailwind removal — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Move the frontend toolchain to **vite 8 + @vitejs/plugin-react 6 + vitest 5**,
the newest versions `.github/dependabot.yml`'s cooldown allows, then **remove
Tailwind** (not upgrade it to v4, §5 S5). Four commits on `develop` (vite 6.4.4
security lockfile — done, `dafecadd` — then vite 8, then vitest 5, then
Tailwind removal), each touching only `package.json`, `package-lock.json` and
config unless a step says otherwise, after a worktree spike. Nothing reaches `main` until all of
them are green on Linux, Windows and macOS and the user's live checks pass: a
merge into `main` is a release.

## 1. Versions: the cooldown rule

- **Rule.** Dependabot waits 7 days for any version, 30 days
  (`semver-major-days`) for a major; all three bumps are majors. Each gets the
  **newest version ≥ 30 days old on the install day** — recompute that day,
  don't copy the table.
- **Resolution, re-verified 2026-10-14 (`npm view … time`):**

  | package | eligible | still cooling (eligible on) |
  |---|---|---|
  | vite | **8.3.0** (09-10) | 8.3.1 (10-24), 8.3.2 (10-31), 8.3.3, 8.3.4 |
  | vitest | **5.0.0** (09-03) | 5.0.1 (10-15), 5.0.2 (10-25), 5.0.3 (10-30), 5.0.4 |
  | @vitejs/plugin-react | **6.1.1** (08-28) | 6.1.2 (11-04) |

  vitest 5.0.1–5.0.4 fixed jsdom `Blob` handling and `--changed`; installing
  on or after 10-15 makes 5.0.1 eligible — take it. The spike checks whether
  5.0.0 hits either bug.
- **Security vs cooldown (fixed decision 9).** vite 8.3.0 is inside the
  10-06 advisories GHSA-rq7h-c2jc-7f22, GHSA-9jrq-w75r-8gcw (the two S0's
  6.4.4 fixed) and GHSA-vfpm-58rq-9qcg; all three are fixed in **8.3.3**
  (10-06, ≥ 7 days old; 8.3.4 is not a security release). Pinning 8.3.0
  regresses S0. npm's bulk audit endpoint did not list them on 10-14 — read
  GitHub's (`api.github.com/repos/vitejs/vite/security-advisories`), not
  `npm audit`. vitest 5.0.0 and plugin-react 6.1.1: no open advisory
  (GHSA-82fw-gwwq-j7x9 is fixed from 5.0.0-rc.2). On the install day, recheck
  all three packages' advisories, not only their dates.
- **Pin exact versions** (`"vite": "8.3.0"`, no caret), so the lock cannot
  drift onto a version still cooling.
- **Transitive deps:** install with `--before=<install day − 7 days>` so
  nothing new in the lockfile is under a week old (the pinned majors are older,
  so they resolve under that date). Afterwards check every lockfile entry that
  differs from HEAD against `npm view <pkg> time` (node one-liner).
- **npm 11 for every lockfile write.** PATH's `npm` is Debian's
  `/usr/bin/npm` **9.2.0**; CI's Node 24 bundles npm 11. npm 9 drops the
  `libc` field (HEAD's lock has 34; S0 and `d40529e9` kept them).
  Run installs as `npx -y npm@11.21.0 …` (09-30; recheck the 7-day rule on the
  day). Exit check everywhere: `grep -c '"libc"' package-lock.json` ≥ HEAD's.

## 2. Starting point (verified 2026-10-14, HEAD `d40529e9`)

- **HEAD is consistent.** S0 = `dafecadd`: `package.json` `"vite": "^6.4.4"`,
  the lock resolves vite 6.4.4 (+ nested esbuild 0.25.12), 34 `libc`, root
  `version` 0.2.9 = `package.json`; `npm ls --depth=0` and
  `--package-lock-only` both clean. `d40529e9` (Tauri 2.12) changed only
  `@tauri-apps/*` lock entries. develop is 7 commits ahead of origin, unpushed.
- **Installed:** root vite 6.4.4, plugin-react 4.7.0 (peer vite ≤ 7),
  tailwind 3.4.19; vitest 4.1.11 with its own nested vite 8.3.4 — tests
  already transform via Rolldown/Oxc, with plugin-react 4.7 on vite 8.
- **esbuild:** the lock has **no root esbuild** (only an optional peer of
  react-scan/unplugin/vite 8). The main tree holds a stray, unlocked root
  esbuild 0.28.2 from an earlier npm-9 install; the spike's `npm ci` tree and
  CI lack it, and the landing install may prune it — expected. Nothing in the
  repo imports esbuild; vite 8 needs none (no `esbuild`/`cssMinify:'esbuild'`
  options).
- **No `@types/node`:** 21 `@ts-expect-error` directives in `src/` cover
  `node:*` imports (e.g. `src/__tests__/helpers/cssCorpus.ts:9`); installing
  `@types/node` turns each into TS2578.
- **vitest 5:** peers vite `^6.4||^7||^8` (required), jsdom `*`,
  @types/node (optional); engines node `^22.12||^24||>=26`. Local node
  22.22.1; CI reads `.nvmrc` = 24 (7 setup-node steps in `ci-cd.yml`).
- **No new native binaries:** rolldown 1.2.13 (15 bindings) and lightningcss
  1.33.0 (11 platform packages) are already in the lockfile and installed by
  CI's `npm ci --ignore-scripts`.
- **`npm audit`** (full) flags braces + postcss-selector-parser via
  tailwind 3 (dev-only, so CI's `npm audit --omit=dev` never lists them);
  S5's removal clears them.

## 3. Order, and the planners' conflicts resolved

1. **vite 8 first, then vitest 5 — not all three at once** (Report A).
   Tests already run on vite 8 via vitest 4's nested copy, so the vite bump
   changes the four app bundles and vitest 5 then changes only runner
   behaviour: one variable per commit. vitest-5-first would flip tests to
   vite 6/esbuild and back. Not perfectly isolated: C1 moves the tests'
   plugin-react 4.7 → 6 and lets npm dedupe vitest 4's vite 8.3.4 onto root
   8.3.x — S1a measures exactly that. vite 6.4 gets security patches only, so
   it is a waypoint.
2. **npm version (Report B): confirmed** — 9.2.0 on PATH, `libc` fields
   already stripped (§1). Every write goes through npm 11.
3. **Worktrees (B vs C):** the baseline has main's deps and may hardlink
   (`cp -al`) after deleting caches; the spike changes deps and needs its own
   real install (hardlinks would corrupt main's node_modules). A symlinked
   node_modules zero-collects the pdf.js tests
   (`docs/done/headless_owner_handoff.md:329`): **always compare test counts.**
4. **clearMocks (A's codemod vs C's threshold): both.** `clearMocks: true` on
   vitest 4.1.11 has vitest 5's default semantics; the spike counts the cost
   on the baseline, S2 fixes it on v4, C2 adopts or pins (fixed decision 7).

## 4. Ground rules for every step

- **Never start, stop or restart Tabtivity.** The user's window runs
  `npm run dev` on the main tree's node_modules: never `npm ci` there, only
  `npx -y npm@11.21.0 install --ignore-scripts`, only at landing. Tell the
  user the running window keeps the old vite until *they* restart it.
- **Experiments in `.claude/worktrees/`**, never `target/`; scratch output in
  the session scratchpad (`/tmp` is a tmpfs that fills). Never stash or reset
  the main tree — other sessions edit it concurrently.
- **Commits:** explicit paths (`git commit -- <paths>`), never `-A`. Before
  each, `git diff package.json package-lock.json` shows only this step's
  change (the version-bump hook writes `package.json` too). Bump commits carry
  no test edits; rebase over concurrent test edits and re-diff.
- **Landing (frozen dev build):** `target/freeze-tree` symlinks main's
  node_modules (`scripts/package-dev.sh:99`). Order:
  `scripts/package-dev-auto.sh --status` idle → copy the reviewed
  `package.json` + lock from the spike worktree → main-tree install (must leave
  the lock byte-identical) → `npm ls --depth=0` → commit → `--status` shows the
  queued build on the new deps.
- **Rollback:** `git revert <sha>`, then the same main-tree install.
- **Registry:** if the fence blocks an install, hand the exact command to the
  user. Close Dependabot's separate major PRs for these three when they come.

## 5. Steps

User's routine: plan review → S0…S6, each with a fresh implementer and a fresh
reviewer → final review. S2's batches may run in parallel.

### S0 — vite 6.4.4 lockfile (security; cooldown waived) — DONE `dafecadd`

- Landed as `fix(deps): lock vite 6.4.4 to match package.json`
  (`-- package-lock.json` only): HEAD's lock regenerated with
  `npx -y npm@11.21.0 install --package-lock-only --ignore-scripts`.
  Re-verified at `d40529e9` (§2). Nothing left to do.

### S1 — Spike (worktrees only, no commit)

- **Entry:** S0 committed.
- **Setup:** B = `.claude/worktrees/vt-base` at HEAD with `cp -al` of main's
  node_modules, then `rm -rf $B/node_modules/{.vite,.vite-temp,.vitest-cache}`.
  S = `.claude/worktrees/vt-spike` with its own
  `npx -y npm@11.21.0 ci --ignore-scripts`.
- **Baseline (B):** suite as JSON
  (`npx vitest run --reporter=dot --reporter=json --outputFile=$SCRATCH/base.json`,
  ~817 files / ~8298 tests); `npm run build`;
  `find dist mobile-dist web-dist -type f -printf '%P %s\n' | sort`. Then flip
  `clearMocks: true` and rerun: the failing files are the real clearMocks cost.
- **S1a (S):** vite 8.3.3 (fixed decision 9) + plugin-react 6.1.1 (§1 pins,
  `--before`) + the S3 config edits → build, listing, suite, §6 checks.
- **S1b (S):** + vitest 5.0.0 (or 5.0.1, §1) → suite twice (cold, warm);
  also `--no-fsModuleCache` and `npx vitest doctor`. Time v4 / v5 cold /
  v5 warm with `/usr/bin/time -v`.
- **Compare** per-file status and per-file counts (`test.each` titles shift).
  **Triage** each failure: (a) real break — fails 3/3 alone; (b) flake —
  passes alone, rerun 3× each side (TimeField, user-event, real-timer polls);
  (c) environment — fails in B too, a count change, or cache.
- **Also prove:**
  - `scripts/ci-failed-first.sh`: break one test in S,
    `bash scripts/ci-failed-first.sh frontend`, `.ci-failed/frontend.txt`
    lists it (proves the JSON shape `testResults[].status/name`,
    `numTotalTests`).
  - `npx vitest run --changed HEAD~1 --passWithNoTests` works, and a
    `package.json`-only change reruns everything (`gates.sh:100`,
    `ci-local.sh:158` use `--changed`).
  - whether 5.0.0 hits the jsdom `Blob` or `--changed` bugs;
  - the jsdom smoke cases (§7);
  - tsc over `src/__tests__` (`Assertion<R,T>`, 140 files with
    `vi.mocked`); add `@types/node@^22` only on TS2688 — and then delete the
    21 node `@ts-expect-error` directives (§2, TS2578) in the same commit.
- **Gate D1:** stop and re-plan on unexplained count differences, > ~25
  real-break files, or a §6 check no config fix resolves.
- **Exit:** findings note in the scratchpad — every failing file with its
  class, the clearMocks count, timings, build diff — handed to S2/S3.

### S2 — Pre-fixes valid on both versions (test edits only)

- **Entry:** D1 passed.
- **Do:** explicit `mockClear`/`vi.clearAllMocks` where clearMocks breaks a
  test; awaited `resolves`/`rejects`; jsdom write targets; default JSON
  imports instead of named ones (2 sites; vite 8.3 warns). Where clearMocks
  bites: of 532 files using `vi.fn`/`spyOn`, 138 never clear and 44 of those
  assert history; 72 `mock.calls[0]`/`lastCall` reads in 45 files; 2
  top-level `await import`. Agent-sized batches by directory, on vitest 4.1.11
  in the main tree.
- **Exit:** suite green on v4 *with* `clearMocks: true` (revert the flag
  before committing — C2 owns it); `scripts/gates.sh` green; `test: …`
  commits only.

### S3 = C1 — vite 8 + plugin-react 6

- **Entry:** S2 landed (or nothing was needed).
- **Do:**
  - `package.json`: `"vite": "8.3.3"` (fixed decision 9),
    `"@vitejs/plugin-react": "6.1.1"`.
  - `vite.pdf-frame.config.ts`: `rollupOptions` → `rolldownOptions`;
    `output.inlineDynamicImports: true` → `codeSplitting: false` (Rolldown
    deprecation); keep `format: "iife"` and `entryFileNames`; the comment's
    "Rollup emits an IIFE…" names Rolldown.
  - `build.target` pin (fixed decision 6) in `vite.config.ts`,
    `vite.mobile.config.ts`, `vite.web.config.ts`, `vite.pdf-frame.config.ts`.
    Nothing else required. Escape hatches only on a failed check:
    `legacy.inconsistentCjsInterop`; for `import.meta.url`, `define` +
    `rolldownOptions.output.intro`. No `cssMinify: 'esbuild'` (needs esbuild).
  - Install in S, then land (§4).
- **Exit:** `npm run build` **zero warnings** in all four bundles
  (deprecation and chunk-size warnings break the gate); §6 checks; `npm test`;
  `npm run lint`; `scripts/gates.sh`; `scripts/privacy-check.sh`; the §1
  advisory recheck. Commit `chore(deps): vite 8.3.x + plugin-react 6.1.1`
  `-- package.json package-lock.json vite*.config.ts`.

### S4 = C2 — vitest 5

- **Entry:** C1 landed; its frozen dev build is green.
- **Do:**
  - `package.json`: `"vitest": "5.0.x"` (the eligible one, exact);
    `engines.node` → `^22.13.0 || ^24.0.0 || >=26.0.0` (vitest excludes 25).
  - `vitest.config.ts`: `clearMocks` and `fsModuleCache` per fixed decisions
    7–8.
  - `.gitignore`: add `.vitest/` (default JSON/JUnit output dir;
    `ci-failed-first.sh:55` and `rename-codemods/vt.sh:4` already pass
    `--outputFile`).
- **Expect:** `vi.mock`/`vi.hoisted` must be top-level — all 1137 / 166 are
  at column 0; `vi.doMock` (5) fine. Config lookup no longer walks parents
  (good for worktrees). Unchanged: pool (forks), fake timers; `-t` now joins
  with ` > ` (unused).
- **Exit:** `scripts/gates.sh --all` green; test count equals S1b's. Commit
  `chore(deps): vitest 5.0.x`
  `-- package.json package-lock.json vitest.config.ts .gitignore`.

### S5 = C3 — Remove Tailwind (keep PostCSS + autoprefixer)

Why remove, not upgrade: the app styles itself with its own semantic classes
(`settings-btn`, `modal-backdrop`, …, ~8000 class tokens); no `@apply`, no
`theme()`, and the `tailwind.config.js` colour map is unused. Tailwind 3
contributes only (a) its preflight reset via `@tailwind base`
(`src/styles/base.css:8-10`) and (b) whatever utilities its content scanner
happens to emit. Tailwind 4 would need Safari 16.4 / Chrome 111 CSS
(`@property`, `color-mix()`, `@layer`) — the build-target pin (fixed decision 6)
can't lower generated CSS — and moves preflight into `@layer base`, which
silently reorders it against `base.css`'s load-bearing unlayered cascade.

- **Entry:** C2 landed; its frozen dev build is green.
- **Baseline first (before touching anything, in the step's worktree at
  C2):** `npm run build`; save `dist/assets/*.css` and
  `web-dist/assets/*.css` as `before.css` / `before-web.css` (scratchpad) —
  `vite.web.config.ts` has no `css` block, so the root `postcss.config.js`
  (Tailwind) runs on the web client exactly as on the desktop.
  Also save the exact preflight Tailwind 3.4.19 emits and the full utilities
  output: `npx tailwindcss -c tailwind.config.js -i <in> -o <out>` with
  `@tailwind base;` and, separately, `@tailwind components; @tailwind
  utilities;` (checked 2026-10-14: ~15 s each; base = 555 lines, 103 of them
  `--tw-`). The scanner (content = `index.html` + `src/**/*.{js,ts,jsx,tsx}`,
  tests included) emits **54** utility selectors:
  `container visible invisible collapse static fixed absolute relative sticky
  isolate m-1 block inline-block inline flex table table-cell table-row grid
  contents list-item hidden w-1 w-2 w-7 shrink grow border-collapse transform
  select-all resize flex-wrap overflow-scroll truncate break-all rounded border
  pr-1 uppercase lowercase italic ordinal underline line-through shadow
  outline ring blur grayscale invert filter backdrop-filter transition
  [path:line]` (plus `!`-prefixed twins of `container visible inline table
  hidden ring filter`, false positives from `!x` expressions).
- **Size (rough scan, 2026-10-14):** of the 54, only **2 are used as classes
  in app code** (3 sites), both collisions, both already overridden:
  `inline` (`BoxScopeChip.tsx:477,532` → `.pill-status-bars.inline`; the later,
  equal-specificity `.pill-status-bars{display:flex}`,
  `projects-tabs.css:1592`, beats Tailwind's `display:inline`) and `static`
  (`PillStatusBars.tsx:114` → `.pill-status-bar.static`;
  `.pill-status-bar{position:relative}`, `:1630`, beats it). Expected
  relied-on: **0**; every other hit is prose, a style value or a variable.
  No app CSS defines another bare utility-named class; no app CSS reads a
  `--tw-` var. Third-party DOM: KaTeX and xterm CSS use none of the names;
  pdf.js toggles `.hidden` only in editor/annotation-editor layers the app
  never mounts (canvas + `TextLayer` only). Step 2 re-verifies all of this.
- **Do:**
  1. **Reset.** Vendor Tailwind 3.4.19's preflight into a new
     `src/styles/reset.css`, verbatim, keeping its MIT notice (and
     modern-normalize's), with every `theme(...)` resolved to the value
     3.4.19 emitted (from the saved baseline output, not by hand). Drop only
     the `*, ::before, ::after { --tw-… }` / `::backdrop { --tw-… }` variable
     defaults and preflight's own `::before, ::after { --tw-content: '' }`
     (`tailwindcss/src/css/preflight.css:15-18`; read only by `content-*`
     utilities, never emitted) — nothing in app CSS reads a `--tw-` var; say
     so in `reset.css`'s header.
     **Placement (decided):** delete the three `@tailwind` lines from
     `base.css` and add `@import "./reset.css";` as the **first** line of
     `src/styles/index.css`, before `base.css`. Same cascade (the `@tailwind`
     lines were `base.css`'s first statements), and legal either way — but a
     nested `@import` inside `base.css` would hide the reset from
     `src/__tests__/helpers/cssCorpus.ts` (`readAppStylesheet` follows only
     `index.css`'s imports; 10 CSS-invariant tests use it). Re-homed
     utilities, if any, go at the top of `base.css` where
     `@tailwind utilities` was. Order: reset, kept utilities, rest of
     `base.css`.
  2. **Utilities triage.** For each of the 54 selectors, find every use as a
     class: `className` literals, template literals, `clsx`/`cn`-style calls,
     `classList.add/toggle`, `class=` in HTML strings (`rg -w` over `src/`
     and `index.html`). `mobile-web/` is out: `vite.mobile.config.ts:104-108`
     declares its own `css.postcss`, so the phone never loaded Tailwind;
     `vite.pdf-frame.config.ts` finds the root config but its entry imports
     no CSS. Classify:
     - **relied on** — the element needs the rule (e.g. `hidden` on a node
       with no other `display` rule, `truncate`): re-home the rule as plain
       CSS (no `--tw-` vars) in a "Former Tailwind utilities" block right
       after the reset in `base.css`, same source position as before;
     - **collision** — an app class that shares the name (`border`, `ring`,
       `shadow`, `outline`, `filter`, `transition`, `table`, `collapse`,
       `container`, `visible`, `transform`, `resize`, …) and Tailwind's rule
       leaked onto it: check whether the app's own rules fully override every
       property Tailwind set. If they do, drop it. If they don't, the
       element's current look depends on the leak: keep exactly the leaked
       declarations under the app's own selector (e.g. `.foo.ring`, not bare
       `.ring`) and list it under "Flagged for user" — it may have been a
       latent bug, the user decides later;
     - **unused / false positive** (word only in prose, a string, a
       variable): drop.
     Record the per-selector verdict as a table in the handoff.
  3. **Deps + config:** remove `tailwindcss` from `package.json`; delete
     `tailwind.config.js`; `postcss.config.js` keeps `autoprefixer` only
     (fixed decision: prefixes stay byte-identical in dev and build; swapping
     autoprefixer for Lightning CSS targets is a separate, later choice).
     `postcss`/`autoprefixer` stay. Lockfile via npm 11, `--before` rule (§1),
     only Tailwind's subtree may drop — verify with the §6 dependency checks.
  4. **Docs:** `DOCUMENTATION.md:65` styling row; the comment at
     `vite.mobile.config.ts:101-103`; `base.css`'s and `index.css`'s headers.
     `docs/filemap_frontend.md` has no `src/styles` or config rows — add none.
- **Tests (new, permanent — `src/__tests__/theme/`, beside the other
  stylesheet invariants):** read files as text with `readFileSync` and
  cssCorpus.ts's `@ts-expect-error node:fs` line (no `@types/node`);
  `css: false` doesn't matter for text reads, jsdom env is fine.
  - `NoTailwind.test.ts` — no `@tailwind`, `@apply`, `theme(`, `screen(` or
    `--tw-` in any CSS under `src/` and `mobile-web/src/` (comments
    stripped first — `reset.css`'s header names them); `package.json`
    has no `tailwindcss` / `@tailwindcss/*`; no `tailwind.config.*` at the
    root; `postcss.config.js` names no `tailwindcss`.
  - `ResetParity.test.ts` — the expected preflight is captured **once, from
    the baseline output above, before removal** and frozen into the test as a
    `selector → {property: value}` table (the whole preflight, not a
    sample), minus the dropped `--tw-` declarations. The test parses
    `src/styles/reset.css` with **`postcss.parse`** (`postcss` stays a direct
    devDependency, pure JS — not Lightning CSS, which after C1 is only a
    transitive native dep of vite) and asserts every expected declaration is
    present with the same value, in the same rule order, plus that
    `index.css`'s first import is `./reset.css`. Proves the vendored reset is
    exactly Tailwind 3.4.19's.
  - `FormerUtilities.test.ts` — every class token used in `src/` code
    outside `__tests__` (the same scan as step 2: literals, template
    literals, `classList`) that is one of the 54 names above must appear as a
    class in some selector of our CSS (`readAppStylesheet()` + the component
    sheets `QuickOpen.css`, `ImageAnnotator.css`, `dev/devPerf.css`); a
    compound like `.pill-status-bars.inline` counts, so today's two
    collisions pass without an allowlist. Catches a re-homing miss and anyone
    later writing `className="truncate"` expecting Tailwind.
  - Prove each test fails when it should: temporarily re-add `@tailwind base`
    / alter one reset value / remove one re-homed rule, see red, revert.
- **Build-output checks (step exit, not permanent):**
  - `after.css` vs `before.css` (and the `-web` pair): diff the two after
    removing the baseline's
    utility rules and `--tw-` defaults (scripted, in the scratchpad). Every
    remaining difference must be a re-homed rule's formatting or a
    documented drop from step 2. Every `-webkit-` / `-moz-` declaration in
    `before.css` is still in `after.css`.
  - **Headless WebKitGTK probe** (offscreen `WebKit2` 4.1 via
    `/usr/bin/python3` + `gi` — checked 2026-10-14, WebKitGTK 2.52 loads;
    never the user's window): script in the scratchpad, `Gtk.OffscreenWindow`
    + `WebKit2.WebView`, `evaluate_javascript` for computed styles,
    `get_snapshot` for PNGs; env `GDK_BACKEND=x11
    WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
    GTK_OVERLAY_SCROLLING=0` (else no GL context under Wayland). One fixture page
    with the elements preflight touches (`h1`–`h6`, `p`, `ul`/`ol`, `button`,
    `input`, `select`, `textarea`, `table`, `img`, `svg`, `hr`, `a`, `code`,
    `abbr`, `sub`, `summary`, `[hidden]`) plus one element per kept or
    collision class (today `.pill-status-bars.inline` with a
    `.pill-status-bar.static` child), loaded once with `before.css` and once with
    `after.css`; `getComputedStyle` of every property on each must match.
    Save both PNG snapshots and diff them.
- **Exit:** the three tests green; `npm run build` zero warnings; `npm test`;
  `npm run lint`; `scripts/gates.sh`; `scripts/brand-check.sh`;
  `scripts/privacy-check.sh`; full `npm audit` no longer lists
  braces / postcss-selector-parser via Tailwind. Commit `chore(deps): remove
  Tailwind; vendor its preflight` `-- package.json package-lock.json
  postcss.config.js tailwind.config.js src/styles DOCUMENTATION.md
  vite.mobile.config.ts src/__tests__/theme/NoTailwind.test.ts
  src/__tests__/theme/ResetParity.test.ts
  src/__tests__/theme/FormerUtilities.test.ts` (+ any TSX whose class it had
  to change, listed in the handoff).

### S6 — Final: CI on three OSes, then PR

- **Entry:** C1 + C2 + C3 on local develop.
- **Do:** `scripts/gates.sh --all`; `scripts/ci-local.sh` full (not
  `--fast`); push develop via `git_push`; watch `ci_runs`/`ci_run` on all
  three OSes; compare test-step durations with the last green run (timeouts
  60/100/100 min, `ci-cd.yml:244,348,428`; CI's cache is cold). Watch the
  Windows build step: the pdfjs alias exists because entry resolution once
  failed there, and Rolldown's resolver is new. Add the §8 🖐️ boxes.
- **Exit:** develop CI green on three OSes; frozen dev builds start on each;
  the user ran §8 → PR to `main` (merging it is a release).

## 6. Checks for C1 (vite 8)

**Output vs the baseline listing:**
- Flag > 10 % size change per file; Lightning CSS now minifies — compare
  `grep -c -- -webkit-` across the CSS.
- `stampServiceWorker` (`vite.mobile.config.ts`): `mobile-dist/index.html`
  names `/assets/index-<hash>.js`; `sw.js` has no `__APP_BUILD__` /
  `__APP_ASSETS__` left; every stamped asset exists.
- pdf-frame: name matches `^assets/pdf-frame-[A-Za-z0-9_-]+\.js$`; classic
  script (no top-level `import`/`export`); count `import.meta` occurrences.
  IIFE output no longer polyfills `import.meta.url` (→ `undefined`); pdf.js's
  `_scriptName` uses (the frame imports the legacy build,
  `pdfFrame/main.ts:23-24`: `legacy/build/pdf.worker.mjs:15208/16055`) sit
  in `try{}` and `legacy/build/pdf.mjs`'s Node-only branch never runs — expect a warning, no break; the
  live JPX check (§8) is the proof.
- `web-dist/index.html` uses the `/desktop/` paths and the main-web entry.
- CJS interop: `@pdf-lib/fontkit` default imports
  (`src/lib/viewers/deck/fonts.ts:26`, `src/lib/viewers/deck/export.ts:33`); katex + mermaid
  (`src/lib/viewers/markdownEnrich.ts:30-31`).

**Dependencies, after every install:**
- `npm ls vite vitest @vitejs/plugin-react rolldown lightningcss` → exactly
  one vite.
- Node one-liner over the lock: `@rolldown/binding-{win32-x64-msvc,
  darwin-arm64,linux-x64-gnu}` and `lightningcss-{win32-x64-msvc,darwin-arm64}`
  still present (a Linux regeneration can drop platforms).
- `npm ls --package-lock-only --depth=0` (= `ci-local.sh:146-151`); `libc`
  count kept; every changed entry ≥ 7 days old (§1).
- Drops (C1/C2): root vite 6 + esbuild 0.25 + its `@esbuild/*`; rollup 4 +
  `@rollup/rollup-*` if only optional peers name them; vitest 4's nested vite;
  plugin-react's babel jsx-self/source (`@babel/core` stays for react-scan).
  Adds (C2): obug, magic-string 1.x, tinybench 6, why-is-node-running 3,
  std-env 4, `@vitest/mocker`/`spy` 5. No root esbuild enters the lock
  (vite 8's peer is optional, §2); if one appears, find who pulled it.
- CI scanners: privacy-check + gitleaks read the lockfile diff; brand-check
  skips the lockfile; `security.yml:81` runs `npm audit --omit=dev`.

## 7. Risks

- **Build target rises** — vite 8 defaults to safari16.4/chrome111 (vite 6:
  ~safari14/chrome87); macOS `minimumSystemVersion` is 10.15 (Safari ≤ 15.6);
  older phone browsers too. The pin (fixed decision 6) removes it.
- **Shipped bundles change** — `tauri.conf.json` `beforeBuildCommand` runs
  `npm run build`: Oxc minifier, Lightning CSS and Rolldown chunking ship.
  Only §6 + §8 prove them.
- **jsdom globals now real** — writes to `window`/`globalThis` reach the jsdom
  window; getter-only targets throw (vitest PR #10373). Direct writes:
  `TourSelection.test.ts:132` (innerWidth), `Appearance.test.ts:116`
  (matchMedia), `PromptChartLift.test.tsx:93` + `TodoOverlay.test.tsx:176`
  (ResizeObserver), `test-setup.ts` (fetch, `__TAURI_INTERNALS__`);
  `vi.stubGlobal` of location/navigator/crypto in 6 files
  (`MobileAppSession.test.tsx:112`, `MobileAuth.test.ts`, …). S1 smoke-runs
  them.
- **Flakes vs regressions** — S1's triage; `test.each` title churn (25 uses).
  Unawaited `resolves`/`rejects` now fail; all 215 are awaited or returned
  (`CopilotCompletionProvider.test.ts:64` stores and awaits later — fine).
- **Shared module cache** — `fsModuleCache` caches in node_modules, shared by
  the freeze tree and hardlinked worktrees; a stale cache can mask or fake
  failures (fixed decision 8).
- **Cross-OS** — `ci-local.sh` is Linux-only; Windows and macOS are proven
  only by develop CI and frozen builds.
- **Concurrent sessions** — tests or `package.json` change mid-step; re-diff
  before each commit (§4).

## 8. Live checks for the user (after *they* restart dev)

- **Desktop (WebKitGTK):** boot, hot reload, terminal (webgl), PDF viewer,
  markdown with mermaid + katex, xlsx viewer, drag-drop, blur/backdrop/
  scrollbar styling; the frozen post-commit dev build launches.
- **After C3 (Tailwind removal):** Settings dialog, a project dialog, the
  new-tab menu, mail compose, calendar event dialog, the file tree and a
  markdown/table viewer look unchanged (buttons, inputs, headings, lists,
  borders); the box chip menu's root row status bars (the `inline`/`static`
  collision sites); each "Flagged for user" collision element from S5; the
  same on the web client at `/desktop/` (it loaded Tailwind too).
- **Phone PWA:** the new service worker installs (shows the new commit),
  offline reload, themed splash, calendar / to-do / terminal.
- **PDF frame on the phone:** scroll, zoom, marks; a scanned **JPX** PDF
  renders.
- **Web client** at `/desktop/`.
- **Windows / macOS:** the desktop list on frozen dev builds, as 🖐️ boxes in
  `todo/group-h-crossplatform.md`, each with `✅ Works on <P>` /
  `❌ Doesn't work on <P>` children for `Linux (X11)`, `Linux (Wayland)`,
  `Windows`, `macOS` (listed here; S6 adds them).

## Decisions already made (by the user)

1. **Target:** vite 8 + plugin-react 6 + vitest 5, newest stable under the
   Dependabot cooldown — per major the newest version ≥ 30 days old,
   recomputed on the install day; transitive deps via `--before=<day − 7>`;
   exact pins. Today: vite 8.3.0, vitest 5.0.0, plugin-react 6.1.1.
2. **vite 6.4.4 security bump is S0**, its own commit, first (security
   updates ignore the cooldown).
3. **Process:** plan in `docs/`; plan review → agent-sized steps → fresh
   implementer + reviewer per step → final review.

4. **Tailwind:** remove it, don't upgrade to v4 (2026-10-14). S5 runs after
   C2, as its own commit; PostCSS + autoprefixer stay; the preflight is
   vendored verbatim; tests prove reset parity and that no used class lost
   its rule.
5. **Run:** "start migration using subagents" (2026-10-14) — the routine
   above, batched per the Agent steps table.

6. **`build.target`** (2026-10-14): pin vite 6's old default
   `['es2020','edge88','firefox78','chrome87','safari14']` in all four
   configs; `minimumSystemVersion` stays 10.15.
7. **`clearMocks`** (2026-10-14): adopt vitest 5's default (`true`) if S1
   counts ≤ 10 real-break files (S2 fixes them); otherwise pin
   `clearMocks: false` with a TODO in `todo/group-y-verification.md`.
8. **`fsModuleCache`** (2026-10-14): `false` at landing; revisit only if
   S1's cold/warm numbers show a real gain and a clean-cache rerun matches.
9. **vite 8.3.3**, not 8.3.0 (2026-10-14): a security release skips the
   30-day cooldown (as S0 did); 8.3.0 carries the 10-06 advisories.

10. **After A1a** (2026-10-14, main agent; conventional, not the user's):
    - Base is HEAD `78c6bb4b` (TS 7, xterm 6, katex, pdfjs, minor bumps
      landed); rebase every step over whatever lands next.
    - `libc` count: HEAD has 5 (19f00302 dropped them); exit check is
      "≥ HEAD's count", restoring the 34 is out of scope.
    - Build warnings: HEAD already prints 3 chunk-size warnings; exit is
      "no warning beyond HEAD's", `chunkSizeWarningLimit` stays.
    - C1 may also carry the `.ts` config-import suffixes, the pdf-frame
      `define` + `output.intro` for `import.meta.url`, and the 3-line
      `mobile-web/src/themeColors.ts` `source` fix (A1a's patches).
    - `package.json` key order: whatever npm writes.
11. **After A1b / Gate D1 passed** (2026-10-14): vitest **5.0.0** (5.0.1
    reaches 30 days only on 10-15); clearMocks costs 1 file → adopt `true`;
    S4 writes `fsModuleCache: false` explicitly (5.0.4 flips the default).
12. **xterm scrollbar leak: drop** (user, 2026-10-14). Tailwind's
    `.visible`/`.invisible` reach xterm's scrollbar (A5a triage); C3 does not
    re-home them, so xterm's 800 ms fade-out returns and the scrollbar hides
    with the pane layer during a window move. Expected probe diffs on those
    xterm nodes only; listed in §8.

## Agent steps

| agent step | plan section | files |
|---|---|---|
| A1a | S1 setup, baseline B (+ clearMocks cost), S1a vite 8 in S (no commit) | worktrees only; findings note part 1 |
| A1b | S1b vitest 5 in S: cold/warm runs, `ci-failed-first`/`--changed` proofs, jsdom smoke, tsc, timings, Gate D1 verdict (no commit) | worktree S; findings note part 2 |
| A2+A3 | S2 (1 file: `MarkdownEnrich.test.ts`, A1b's patch) + S3 = C1 vite 8.3.3 + plugin-react 6.1.1 + A1a's 3 extra fixes, incl. landing — merged after D1 (S2 shrank to one file) | `src/__tests__/viewers/MarkdownEnrich.test.ts`, `package*.json`, `vite*.config.ts`, `mobile-web/src/themeColors.ts` |
| A4 | S4 = C2 vitest 5, incl. landing | `package*.json`, `vitest.config.ts`, `.gitignore` |
| A5a | S5 baseline (no commit): `before*.css`, Tailwind base/utilities output, frozen preflight table, step-2 triage table, probe script run on `before.css` | worktree at C2; scratchpad |
| A5b | S5 = C3: reset + removal + the three tests (fail-proofs), lockfile, docs, `after*.css` diff, probe rerun, landing | `src/styles/{index,base,reset}.css`, configs, `src/__tests__/theme/` |
| — | S6 CI + PR: main agent, push only after the user says so | — |

Why split: S1 is ~8 full-suite runs (~4 min each on v4) plus builds; S5's
WebKit probe harness is its own day. A1a/A1b and A5a/A5b hand over through
the findings note / handoff, nothing else.

Each agent step gets a fresh reviewer; one final reviewer over the whole
range. Handoff: `docs/done/vite8_vitest5_handoff.md`.

## Decisions open for the user

None.

## Sources

- Vite: https://vite.dev/guide/migration · https://vite.dev/releases ·
  https://vite.dev/config/build-options
- Vitest: https://vitest.dev/guide/migration ·
  https://github.com/vitest-dev/vitest/releases (5.0.1–5.0.4) ·
  https://github.com/vitest-dev/vitest/pull/10373 (jsdom globals)
- plugin-react:
  https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md
- Rolldown (`codeSplitting`, IIFE): https://rolldown.rs · Lightning CSS:
  https://lightningcss.dev
- Tailwind 3 preflight: `node_modules/tailwindcss/src/css/preflight.css`
  (3.4.19, MIT); v4 browser floor: https://tailwindcss.com/docs/compatibility
- Dependabot cooldown:
  https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#cooldown-
- npm `--before`: https://docs.npmjs.com/cli/v11/commands/npm-install#before
- In repo: `.github/dependabot.yml`, `.github/workflows/ci-cd.yml`,
  `scripts/{gates,ci-local,ci-failed-first,package-dev,package-dev-auto}.sh`,
  `docs/context/dev_builds.md`, `docs/done/headless_owner_handoff.md:329`.
