# Repo root cleanup — plan

Status: plan only (2026-10-05). Two review passes by a subagent, both folded
in: the first covered the original draft, the second the steps added after
the user refined the goal (marked †). Nothing is implemented.

## Goal

GitHub lists **every tracked root entry**, dotfiles and dotfolders included,
above the README. Today that's 35 files and 13 folders, **48 rows**, so the
README starts far down the page. The aim is to move or remove every tracked
root entry that doesn't have to live there.

Tabtivity's own file tree is not the target. It already folds the scaffold,
dotfiles and gitignored entries.

User decisions (2026-10-05):

- **The six scaffold docs stay at the root:** `PROJECT`, `REMARKS`, `TODO`,
  `ROADMAP`, `STATUS`, `DOCUMENTATION`.
- **The three `start-eldrun-*.sh` shims are deleted now**, not at rename
  release B, once the check in step 1 shows nothing still uses them.

## Result

| | Files | Folders | GitHub rows |
|---|---|---|---|
| Now | 35 | 13 | 48 |
| After steps 1–5 | 25 | 9 | 34 |
| After step 6 (dev-build shim gone) | 24 | 9 | 33 |
| With optional step 7 | 23 | 9 | 32 |

What remains, and why:

- **Tools require it at the root:**
  - `package.json`, `package-lock.json`;
  - `Cargo.toml`, `Cargo.lock` (workspace root with `[patch]`/`[profile]`;
    moving it would move `target/`);
  - `tsconfig.json`, `vite.config.ts`, `index.html`;
  - `eslint.config.js` (flat-config patterns are relative to the config
    file's folder);
  - `vitest.config.ts` (see below).
- **Git and GitHub require it there:** `.gitattributes`, `.gitignore`,
  `.github/`, `.githooks/` (moving it would mean re-running `core.hooksPath`
  in every clone and worktree for one row).
- **Licenses:** `LICENSE-APACHE`, `LICENSE-MIT`. GitHub only detects
  licenses at the root.
- **Agent CLIs auto-load them, plus GitHub's README:** `README.md`,
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.
- **Scaffold, kept by your decision:** the six docs above.
- **Real code and doc areas:** `src/`, `src-tauri/`, `mobile-web/`, `docs/`,
  `scripts/`, `todo/`, `docker/` (`sandbox.rs:121-124` `include_str!`, plus a
  runtime `<project>/docker/agent-sandbox` lookup).

`vitest.config.ts` stays because the alternatives are both bad:

- Folding it into `vite.config.ts` breaks `test:watch` (that config's
  `server.watch` ignores `src/__tests__`), turns on the `pdfjs-dist` alias in
  tests, and has one file loaded by two Vite majors.
- Moving it behind `--config` breaks every bare `npx vitest` an agent or IDE
  runs: no jsdom, mass failures.

## Is it worth it?

Partly. Even at 32 rows the README still starts below the first screen. The
steps also differ a lot in cost per row:

| Do | Rows | Risk / effort |
|---|---|---|
| Delete the eldrun shims (part of step 1, no launcher move) | −3 | trivial once the desktop-entry check comes back clean |
| `shared/`, `test-fixtures/`, `site/` (steps 4–5, without screenshots) | −3 | low, mechanical |
| Mobile configs (step 2) | −3 | low, but only after `hosted` |
| PostCSS + Tailwind (step 3) | −2 | low, but only after `hosted` |
| `screenshots/` (step 5) | −1 | needs your privacy review of the PNG |
| Move the Tabtivity launchers (rest of step 1 + step 6) | −3 | **highest:** touches the dev-build relaunch and your desktop entries |
| `.gitleaksignore` (step 7) | −1 | three callers for one row |

Recommendation: do the first four rows (−11 rows, 48 → 37), and skip the
launcher move and step 7. Do `screenshots/` only if you review the PNG
anyway.

## Sequencing

Steps 2 and 3 should land **after `hosted` is merged into develop.** That
branch is about 213 commits ahead. It edits `package.json` scripts,
`vite.config.ts`, `eslint.config.js`, `backend-stale.sh`, `brand-check.sh`,
moves `brand.rs` to `src-core/`, and adds four root entries (`src-core/`,
`src-gateway/`, `src-serverd/`, `vite.web.config.ts`).

Re-count after the merge. Those four are new rows the merge itself has to
justify, and folding `vite.web.config.ts` into `mobile-web/`-style placement
is out of scope here.

Steps 1, 4 and 5 are low-risk to land before the merge. `hosted` touches
some of the same files (`.gitignore`, `backend-stale.sh`, `brand-check.sh`,
`storage.rs`, `i18n.ts`, `docs/filemap_frontend.md`), but in separate hunks.
It adds no new users of `shared/`, `test-fixtures/`, `site/`, Tailwind,
PostCSS or `.gitleaksignore`.

## Steps (one commit each, each green on its own)

### Step 0 — local leftovers (no commit; each item needs your OK)

These are untracked, so they don't affect GitHub. They're listed only
because they clutter the checkout.

- Delete:
  - `.aider.chat.history.md`, `.aider.input.history`, `.aider.tags.cache.v4/`;
  - the empty `.agents/`, `.codex/`, `test_projects/`, `emails/`;
  - `project.1782731371.bak.json`, `project_default_apps.json.migrated`;
  - `tsconfig.tsbuildinfo`, a leftover from a `tsc -b` (plain `tsc` without
    `incremental` never writes it). Also fix the `.gitignore` comment that
    claims `npm run build` writes it.
- Move outside the repo: `namesearch/` and `tmp/`.
- Keep `project.json`, `open_apps.json` and `.eldrun_colors.json`. Tabtivity
  reads them.

### Step 1 — launchers to `scripts/`, eldrun shims gone (−5 rows now, −6 after step 6)

Do it as one commit. A move-then-edit split would leave a commit whose
`ROOT` points at `scripts/`, which breaks `. "$ROOT/scripts/lib/brand.sh"`
and the relaunch.

**Before the commit, run the check.** Ask the user to run this **outside
Tabtivity** (agent tabs see a fenced `$HOME`):

```sh
grep -l 'start-\(eldrun\|tabtivity\)-' ~/.local/share/applications/*.desktop ~/Desktop/*.desktop ~/.config/autostart/*.desktop 2>/dev/null
```

- Any hit naming `start-eldrun-*` gets repointed with the `sed` below before
  the shims are deleted. That includes `EldrunHotReload.desktop` and
  `Eldrun.desktop` entries left over from pre-rename `package-local.sh`
  runs.
- The user's dock or launcher favourites follow the `.desktop` file, so
  repointing the file is enough.

The changes:

- **The three Tabtivity launchers move.**
  - `git mv start-tabtivity-{dev-build,dev-sandbox,tauri-hotreload}.sh scripts/`.
  - In each, set `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"`.
    It has to stay absolute: the launchers `pgrep -f "^$ROOT/…"`, call
    `app_legacy_pids "$ROOT"`, and export `DEV_SOURCE_ROOT`.
- **Delete** `start-eldrun-{dev-build,dev-sandbox,tauri-hotreload}.sh` and
  the stub `scripts/eldrun-dev.cmd`, which is the same kind of shim. Drop
  their ALLOW entry at `brand-check.sh:118`. This is tidying: brand-check
  only reports an entry that matches nothing when run with `--list`.
  - `brand.rs` keeps `LEGACY_DEV_LAUNCHER_SCRIPT` and its test at `:659`,
    since it names what older builds wrote. It's a `pub const` in
    `pub mod brand` and is referenced from `Name::ALL`, so clippy reports no
    dead code. No test refers to the shim files.
  - `brand-flip.sh` and `prose-pass.sh` are finished rename tooling. Leave
    them as they are.
  - In `docs/rename_plan.md`, mark the shim removal (the `:179` row) done
    early. The `rename_phase*_handoff.md` files are history and stay
    untouched.
- **Add a temporary root shim `start-tabtivity-dev-build.sh`.**
  - It's 3 lines that `exec` the `scripts/…` copy.
  - The frozen binary running when this lands joins `SOURCE_ROOT` with the
    bare script name (`dev_build.rs:466-474`) for its Relaunch.
  - The review confirmed the launcher and `guard-single-instance.sh` behave
    the same through an `exec` shim.
  - Step 6 removes it.
- **Leave `brand.rs:380` `DEV_LAUNCHER_SCRIPT` untouched.** `names!` derives
  the legacy twin from the same pattern, so changing the pattern would break
  `legacy_names_are_exactly_what_older_builds_wrote`. Instead,
  `dev_build.rs:471` becomes
  `Path::new(root).join("scripts").join(DEV_LAUNCHER_SCRIPT)`, the same way
  `:430` builds `scripts/package-dev-auto.sh`.
- **Update the scripts that write or print launcher paths:**
  - `package-dev.sh:40` `LAUNCHER=`, which becomes the dev entry's `Exec=` at
    `:304`;
  - `package-local.sh:62`, the HotReload entry's `Exec=`;
  - `backend-stale.sh:394`, which prints the hot-reload command.
- **Make the dev entry heal itself.** In the dev-build launcher's adopt
  branch, rewrite `Exec=` in its own desktop entry next to the existing
  `Comment=` `sed`. `package-dev.sh` skips the install while the window runs
  or when fenced (`:254-280`), so the adopt branch is what actually updates
  the user's entry. `rename_plan.md:179` already sanctions rewriting
  Tabtivity's own entry.
- **`brand-check.sh:110`:** add `"scripts/start-$APP_SLUG-*.sh"`, and keep
  the root pattern while the shim exists.
- **Docs and comments:**
  - `docs/*.desktop`, `docs/guide/building.md`, `docs/context/dev_builds.md`,
    `DOCUMENTATION.md`, `docs/README.tex`, the `todo/` hits;
  - comments at `paths.rs:586`, `storage.rs:274`, `dev_build.rs:261`,
    `guard-single-instance.sh` and `package-dev.sh:254,274`.
  - Delete the stale `docs/start-tabtivity-tauri-hotreload.sh`, a
    pre-`brand.sh` copy.
  - Fix `docs/Tabtivity.desktop`'s `Exec=`, which points at a root
    `start-tabtivity-tauri.sh` that doesn't exist.
- **Final report to the user:** one `sed` to run outside Tabtivity. It
  repoints any `.desktop` whose `Exec=` names a root
  `start-{tabtivity,eldrun}-*.sh` to `<repo>/scripts/start-tabtivity-*.sh`.
  The eldrun names map to the tabtivity ones.

### Step 2 — mobile build configs into `mobile-web/` (−3 rows; after `hosted`)

- `vite.mobile.config.ts` → `mobile-web/vite.config.ts`;
  `vite.pdf-frame.config.ts` → `mobile-web/vite.pdf-frame.config.ts`;
  `tsconfig.mobile.json` → `mobile-web/tsconfig.json` (`include: ["src"]`).
- Fix the relative imports:
  - `./mobile-web/src/{pageColors,shellAssets,themeColors}` becomes `./src/…`;
  - `./src/lib/brand` becomes `../src/lib/brand`.
- Make `root` and the `pdfFrame/main.ts` input relative to the config
  (`fileURLToPath(new URL(".", import.meta.url))`).
- Reword the comment at mobile config lines 101-103 ("the root config").
- `package.json`: `mobile:build` → `tsc -p mobile-web`, and
  `mobile:bundle`/`mobile:dev` → `--config mobile-web/…`.
- `backend-stale.sh:191`: the new paths, plus the pdf-frame config, which is
  missing from that list today.
- Update the comments in `mobile-web/src/*` and `public/sw.js`, plus
  `docs/filemap_frontend.md`.
- The review confirmed `tsc -p mobile-web` resolves `../src/lib` and
  `shared/` the same way as today.

### Step 3 † — PostCSS into `package.json`, Tailwind config into `src/styles/` (−2 rows; after `hosted`)

- Delete `postcss.config.js`. Add a `"postcss"` key to `package.json`:
  `{ "plugins": { "tailwindcss": { "config": "./src/styles/tailwind.config.js" }, "autoprefixer": {} } }`.
  - Vite's `postcss-load-config` searches `package.json` too, so **automatic
    discovery still works**. `hosted`'s `vite.web.config.ts` (no own
    `css.postcss`) keeps getting Tailwind, which is the trap the first review
    found with inlining into `vite.config.ts`.
  - The mobile config declares its own `css.postcss`, so it is unaffected.
- `git mv tailwind.config.js src/styles/tailwind.config.js`. Tailwind 3
  resolves `content` globs against the cwd unless `relative: true` is set, so
  `./index.html` and `./src/**` keep working from npm scripts.
- Add no `.vscode/settings.json` for Tailwind IntelliSense. It would be a
  new tracked root row, and the extension should find
  `tailwind.config.*` in subfolders on its own. That's unverified.
- Check that the desktop and (after the merge) web CSS bundles are
  byte-identical before and after.

### Step 4 — `shared/` → `src/lib/shared/` (−1 row)

- Rewrite the **23** importers: 8 mobile, 10 `src`, and 5 tests, including
  the dynamic `await import(...)` at `MobileTerminalLimits.test.tsx:138`.
- **No blind `sed`.** `TexLinks.test.ts:169,186,261` hold an unrelated
  `"../shared/defs"`.
- Vitest's `include`: drop `shared`.
- Update the comments: `schedule_usage.rs:1`, `markup.rs:1033`,
  `i18n.ts:2672`, `mobile-web/src/prefs.ts:62`, `api.ts:646`,
  `agentUsageResets.ts:6`, `docs/third_party_update_checklist.md:225`, and
  the filemap rows.
- No type-check risk: these files are already checked under the root's
  strict settings through their imports.

### Step 5 — three folders into existing ones (−3 rows)

- **† `test-fixtures/` → `src-tauri/tests/fixtures/`.**
  - Its only code user is `schema_roundtrip.rs:22-29`. That function walks
    up from `CARGO_MANIFEST_DIR` with `.parent()`. It becomes
    `PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")`,
    using separate `join` calls rather than `join("tests/fixtures")`, for
    the cross-OS path tests.
  - `.gitignore:28-29` becomes the single line
    `!src-tauri/tests/fixtures/project.json`. Without it, the global
    `project.json` rule at `:21` drops the fixture. The old `!test-fixtures/`
    line was redundant. No other fixture name matches an ignore rule.
  - The target folder already holds `mail/`, with no name clashes.
  - Delete `brand-check.sh:74`: the existing `'src-tauri/tests/fixtures/*'`
    entry at `:76` covers the moved files. Leave the finished
    `prose-pass.sh` alone.
- **† `site/` → `docs/site/`.**
  - `pages.yml`: the comment at `:3`, the `paths:` trigger at `:9`, the
    `site/assets` copy lines at `:62-65` and `source: ./site` at `:75` all
    become `docs/site`. `destination: ./_site` and the upload step stay.
  - Pages is built by Actions, so the folder can be anywhere.
    `_config.yml` has nothing relative to the repo root, and `index.md`
    uses relative `assets/…` links. brand-check's `docs/*` entry covers the
    new location.
- **`screenshots/` → `docs/media/`. Blocked on your review.**
  - `screenshots/eldrun-current.png` (blob `bac1fd53`) isn't in
    `privacy-reviewed-binaries.txt`.
  - `privacy-check.sh:507` diffs with `--no-renames`, so the moved PNG counts
    as a new binary and every hook plus CI blocks.
  - So you look at it and approve its line, or it gets retaken.
- **Screenshot follow-ups:**
  - Update `README.md`, `pages.yml:10,63`, `brand-check.sh:120-123` and
    `brand-flip.sh:207-210`.
  - `take-screenshot.sh` defaults to the ignored `tabtivity-screenshots/`.
  - **Keep `screenshots/` in `.gitignore`.** It's in `GITIGNORE_DEFAULT`
    (`projects.rs:3106`), and scaffold repair would re-add it.

### Step 6 — drop the dev-build root shim (−1 row)

Do this once you have relaunched into a frozen build made after step 1. From
then on the running binary looks in `scripts/`, and the dev entry's `Exec=`
has been rewritten by the adopt branch.

- Delete `start-tabtivity-dev-build.sh`.
- Remove the root pattern at `brand-check.sh:110`.

### Step 7 † (optional) — `.gitleaksignore` → `.github/gitleaksignore` (−1 row)

gitleaks runs in three places, and each one needs the ignore-path flag:

- `.githooks/pre-commit:43`
- `.githooks/pre-push:146`
- `ci-cd.yml:118`

`privacy-check.sh` doesn't run gitleaks itself. Its `:317-321` is only a
`sed` rule. Before relying on the flag, confirm its spelling with
`gitleaks git --help` on v8.30.1 (expected `-i/--gitleaks-ignore-path`).

The old path is also named in:

- `ROADMAP.md:191`;
- `DOCUMENTATION.md` (the gitleaks paragraph, around `:1494`);
- `security.yml:7`;
- the file's own header, which says "read by security.yml" and is already
  stale.

Drawback: a bare local `gitleaks` run no longer finds the file. Worth it
only if you want every row.

## Verification (per step)

- All `AGENTS.md` gates, `git diff --check`, and the privacy check on the
  range.
- **Step 1:**
  - `npm run backend:stale`;
  - `cargo test` (covers `legacy_names_are_exactly_what_older_builds_wrote`);
  - `scripts/brand-check.sh`.
- **Step 2:** an identical `mobile-dist/` file list before and after
  `npm run mobile:bundle`.
- **Step 3:** identical CSS output.
- **Step 4:** the same `npm test` **test count**.
- **Step 5:**
  - `cargo test --test schema_roundtrip`;
  - `jekyll build -s docs/site` locally, if Jekyll is available. The Pages
    workflow verifies nothing while the repo has no Pages site: it skips
    with a notice (`pages.yml:31-50`).
- **Live, for the user after step 1's frozen build exists:**
  1. Use Relaunch in the dev build. It should go through the root shim and
     open the new build.
  2. Launch from the dev desktop entry. Its `Exec=` should now name
     `scripts/…`.
  3. Run the printed `sed`, then launch hot-reload from its entry.
