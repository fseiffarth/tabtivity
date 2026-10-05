# Rename phase 3 — the flip, release A (2026-10-01); handoff

Branch `rename`, worktree `.claude/worktrees/rename`. The plan is the untracked
`docs/rename_plan.md` (never `git add` it). Earlier phases:
`docs/rename_phase1_handoff.md` (the brand modules' conventions),
`docs/rename_phase2_handoff.md` (the migrator), `docs/context/brand_migration.md`
(why it is shaped as it is).

**The app is now Tabtivity** (slug `tabtivity`, prefix `TABTIVITY_`); the old
name is what `brand::LEGACY` / `LEGACY_BRAND` hold. The migrator and every dual
read are live code from this branch on.

**Nothing was run live.** The app was never started, no package was built, and
no step ran against a real home, state dir, keyring, Docker, tmux server or
network. Tests only. The copy run (`scripts/brand-copy-run.sh`) was **not**
repeated in this phase (an agent tab sees a stand-in for the state dir); its
last result is the one phase 2 recorded.

## Read this before merging into `develop`

The post-commit hook freezes every commit on the main checkout into the dev
build. Once this branch is merged, the next freeze installs a Tabtivity build
(`tabtivity-dev`, desktop entry `TabtivityDev.desktop`; the old `EldrunDev`
entry is removed by the install), and **its first launch is the migration of
the real install**: the state dir moves to `~/.local/share/tabtivity` with a
link at the old path, state files are rewritten, the phone host is retired and
reinstalled under its new name, agent homes are re-pointed. Close every running
window from before the rename first. Builds from before the rename are
unsupported afterwards (they find the state through the link, but see a stale
webview copy and write old key names).

`core.hooksPath` of this clone is an absolute path into the main checkout, so
the hooks that ran for this branch's commits were `develop`'s, not this
branch's.

## Commits

- `2940d253` the flip script; `bump-version.sh` finds the crate's Cargo.lock
  block through the manifest's package name (no flip needed there).
- `df7b9f78` the flip: output of `scripts/brand-flip.sh Tabtivity tabtivity`
  plus the flip points it cannot do by rule, and the tests.
- `cd371114` the prose pass, the tagline, logo text, brand-check, and the
  serde-alias reversal (below).
- The commit after those: this file, and anything the final gate run needed.

## What was flipped

By `scripts/brand-flip.sh <Display> <slug>` (it flips once, refuses a second
rename, needs a clean tree, commits nothing):

- `brand.rs` (`app_name!`, `app_slug!`, `app_upper!`) and `brand.ts` (`BRAND`).
  The `legacy_*` macros, `LEGACY_BRAND`, the pinned ids and `app_repo!` are
  untouched.
- `src-tauri/Cargo.toml` package, `default-run`, `[[bin]]`; the app's block in
  `Cargo.lock`; `package.json`, `package-lock.json`. The library stays `app_lib`.
- `tauri.conf.json` (`productName`, window `title`, `identifier`),
  `tauri.macos.conf.json`, `capabilities/default.json`, `gen/schemas`,
  `entitlements.plist`.
- `index.html`, `mobile-web/index.html`, `terminal-preview.html`,
  `manifest.webmanifest`, `sw.js`.
- `docker/agent-sandbox/Dockerfile`, `.github/workflows/ci-cd.yml` (artifact
  names, the dmg name, release-note text; the repository name is left alone).
- The serde `rename` literals of the two phone keys (four files).
- Files named after the app: `scripts/tabtivity-send.{sh,ps1,cmd}` (and the
  `include_bytes!` paths), `start-tabtivity-*.sh`, `scripts/tabtivity-dev.cmd`,
  the sample desktop entries and launchers in `docs/`,
  `screenshots/tabtivity-functionality.svg`. The three launchers and the
  Windows dev launcher keep a forwarding stub under the old name.
- `.gitignore` and `eslint.config.js` name the app's folders under both names.

By hand, in the same commits:

- **`index.html` pre-paint** reads `tabtivity-<name>` and, while that is
  absent, `eldrun-<name>` (theme, accent, theme-vars, corners).
  `BrandMirror.test.ts` runs the script against storages holding old keys,
  current keys and both.
- **deb**: `bundle.linux.deb` has `provides` / `conflicts` / `replaces`
  `["eldrun"]`. Tauri's config schema accepts it (the crate builds); no
  package was built.
- **`scripts/install_phone.{sh,ps1}`** take the state dir from where the app
  wrote them (`<state>/mobile-control/..`), falling back to the default
  location, and read the current settings key. Not the proposal in the phase 2
  handoff (writing the resolved dir into the script); same effect, no
  templating. The `.sh` one was run against a fake state dir; the `.ps1` one
  was not run.
- **`GITIGNORE_DEFAULT`** has the old-named `-screenshots/` and `-emails/`
  lines beside the current ones, for good (a test holds it).
- **The static send scripts** spell only the new names. The old command (the
  alias on upgraded installs) now exports the project dir and the tab id under
  the current variables before it runs the current command, so a session that
  outlived the update keeps its tab attribution.
- **`PHONE_APP_NAME`** is gone; the phone reads `BRAND.display`.
- **Git hooks** read their switches under both prefixes (`app_var` in
  `pre-commit` / `pre-push`) and set the new ones.
- **Dev tooling state** (phase 2 left it alone; the flip would have orphaned
  it): the per-user privacy denylist is read from `~/.config/tabtivity/` *and*
  `~/.config/eldrun/`; the signing-key generator refuses when a key exists in
  the old-named folder; the release-signing marker in `.git` is honoured under
  either name; `git config eldrun.autoDevBuild false` still switches the auto
  build off; `package-dev.sh` / `package-local.sh` remove the old-named desktop
  entries they replace.
- **One-at-a-time guards**: `scripts/lib/brand.sh` has `app_legacy_pids`, used
  by `guard-single-instance.sh`, `start-tabtivity-dev-build.sh` and
  `backend-stale.sh`, so a running build from before the rename (or a current
  one started from the old-named folder before it moved) is still seen.
- **brand-check**: `COMMENTS_ARE_PROSE=0`. Code may spell neither name; a
  comment may spell the current one but not the old one; the release
  repository's name is ignored. The allowlist says per entry whether it stays
  or goes at release B. Every `brand-check: allow` marker left is needed.
- **Tagline** "A tab for each project. A tab for everything in it.": README
  header (with "formerly Eldrun"), Settings → Updates (`brand.tagline`, five
  languages — there is no About panel), `bundle.shortDescription` (the deb's
  and the Linux desktop entry's text) and `longDescription`, the crate
  `description`, the desktop entry `Comment` written by `package-local.sh`,
  the phone manifest `description`.
- **Logo text**: `aria-label` / `<title>` / wordmark text in all SVGs follow
  the name; the mark is unchanged. `installer/header.svg` 21px → 18px (x 58),
  `installer/sidebar.svg` 27px → 25px; `header.bmp` / `sidebar.bmp` were
  regenerated with `scripts/gen-installer-images.sh` (inkscape + ImageMagick),
  looked at, and their blob ids are in `privacy-reviewed-binaries.txt`.
- **Prose** (`scripts/rename-codemods/prose-pass.sh`): ~600 files. English
  "an Eldrun" → "a Tabtivity" (also in Rust and TS message strings and the
  `{app}` dictionaries); French `d'{app}` / `qu'{app}` → `de {app}` /
  `que {app}`, `cet {app}` → `ce {app}`; Italian `ed {app}` → `e {app}`.
  German genitives are `{app}s` and render "Tabtivitys" (55 places, read
  through). Spanish needed nothing.
- Help corpus: `docs/help/troubleshooting.md` has "After the rename from
  Eldrun"; `docs/help/ask-eldrun.md` is `ask-tabtivity.md` (the topic id
  follows the file name).
- CI's generated release body carries four lines on upgrading across the
  rename (remove them at release B).

## Deviations from the plan and the phase 2 handoff

1. **No serde `alias` for the old phone keys** (`<slug>_mobile_host`,
   `<slug>_mobile_access`). The handoff asked for one; it was added, tested,
   and taken out again:
   - a file that holds *both* keys (an older build wrote it after this one
     did) fails to parse as a whole (`duplicate field`), and every reader of
     these files falls back to an empty default on a parse error — a settings
     file read as empty and then saved is a lost settings file;
   - everything else reads the current key only (the window, the project
     records' `extra`, the sidecar's raw reads), so an alias in the sidecar's
     typed reader would open a project to the phone that the window shows as
     closed.
   What moves the keys is the migrator's `persisted-names` step, as phase 2
   built it. A state file an older build writes *after* that step keeps its old
   key: phone access then reads as off until it is switched on again
   (fail-closed). Tests: `the_old_phone_host_key_is_carried_along_and_never_breaks_the_file`,
   `a_leftover_old_access_key_opens_nothing`.
2. **`screenshots/eldrun-current.png` keeps its name.** A binary under a new
   path must be reviewed for the privacy list, and on looking at it it shows a
   shell prompt's user@host and a session URL — it is already in public
   history under this path, but it was not vouched for again. Retake it.
3. **The hooks, the denylist, the signing folder**: read under both names
   (above). The plan only said "change this repo's hooks to the new names".
4. **`scripts/bump-version.sh`** needed no flip point: it reads the crate name.
5. **The prose pass is its own script**, not a sed line; `brand-flip.sh` does
   the flip points only, as the plan says.
6. **Release notes** are not a file: the upgrade notes are in the CI release
   body, the help corpus and this handoff.

## Not done, and why

- **NSIS `installerHooks`**: not wired (user decision; it cannot be verified
  here). On Windows the new installer may land beside the old install.
- **Webview-data copy on Windows and macOS**: the paths are still unknown
  (`state_gc::webview_data_root` returns `None` there), so UI settings kept in
  the webview start fresh on those systems.
- **macOS**: nothing compiled (`objc2-exception-helper` needs the Apple
  toolchain). `retire_legacy_mobile_host` for launchd is unread by a compiler.
- **Mail store re-key, `~/eldrun` move (Phase M), `REPO` / VAPID subject /
  GitHub repo name (Phase 4)**: out of scope by decision.
- **No in-app guard** against a build from before the rename still running
  when a Tabtivity build starts (only the dev scripts refuse). The state dir is
  renamed under it; it keeps working through the link.
- **`UntestedTag`** for the tagline line: none added.
- **`.githooks`, `index.html`, `.gitignore`, `eslint.config.js`,
  `tauri.conf.json`, the stubs** still spell the old name on purpose; the
  brand-check allowlist marks each "until release B".
- The copy run was not repeated; `scripts/rename-codemods/` is kept.

## Tests that changed meaning

Tests guarded by `if PAIR.renamed() { return; }` held "nothing happens while
the name is unchanged" against the running pair. They now hold it against an
explicit unchanged pair (`testing::UNCHANGED`, `UNCHANGED` in `brand.rs`,
`NAMES, NAMES` in `BrandMigration.test.ts`) and lost their guard, so the
no-op paths stay covered. One keeps its guard:
`with_the_name_unchanged_the_key_file_and_the_labels_are_what_they_were`
(mail), which is about the production pair's byte compatibility and is skipped
now. New: `every_name_moved_with_the_brand`, `an_unchanged_pair_has_no_old_spelling`,
`the_pinned_ids_never_follow_the_name`,
`the_home_tree_is_the_current_name_unless_only_the_old_one_exists`,
`the_default_gitignore_covers_the_generated_folders_under_both_names`, the two
phone-key tests, and the pre-paint cases in `BrandMirror.test.ts`.

Tests that read the machine's own folders (`state_dir_ends_with_app`, the
`paths` tests) accept an install that still has them under the old name, and
`hits::taken_here()` drops the hits of finding those folders — on a
developer's machine before its first Tabtivity launch they are real.

The frozen fixtures `test-fixtures/eldrun_*_session.json` keep their names;
`schema_roundtrip.rs` finds them with `legacy_slug!`.

## Expected at release A (not bugs)

- The first start moves the state dir, leaves a link at the old path, and
  rewrites names inside the state files and agent homes. Projects stay in
  `~/eldrun/`; only a fresh install gets `~/tabtivity/`. The docs and help
  texts say `~/tabtivity/…` throughout.
- The first paint after the upgrade uses the saved theme (the pre-paint
  fallback); the storage keys move right after.
- A project's `.eldrun/` becomes `.tabtivity/` when the project is next opened
  (or in the launch sweep); its `eldrun-screenshots/` / `eldrun-emails/`
  folders stay.
- After a deb upgrade while the app runs, `/usr/bin/eldrun` is gone and the
  agent shims still point at it: fenced CLIs fail until the app restarts.
- A pinned dock or taskbar launcher of the old entry is lost. On macOS
  `Tabtivity.app` lands beside `Eldrun.app`; delete the old one.
- An installed phone app on iOS keeps its old home-screen label until it is
  re-added. Pairing is unaffected.
- Agents ask once more for permission for the app's MCP tools where a
  project's own `.claude/settings.local.json` lists them under the old server
  names; Codex asks once more to trust the session hook.
- `eldrun-send` works as an alias for one release, on upgraded installs only.
- Settings → Updates → "Names from before the rename" is never empty on an
  install that keeps `~/eldrun/`: finding the home tree there is counted
  (`home-tree`) until Phase M.
- A synced peer still on an older build appends a second box-links block:
  update all machines together.
- Environment variables are exported under both prefixes (never the secrets);
  a user's own scripts that set `ELDRUN_*` keep working until release B.
- The dev build's files (`tabtivity-dev`, logs) stay in the old-named
  per-user folder until the first launch has moved it.

## Edits inside non-Linux `cfg` code (this phase)

Windows-only, type-checked, never run: the `include_bytes!` paths of the
`.cmd` / `.ps1` send scripts in `agent_bin.rs`. `scripts/install_phone.ps1`,
`scripts/tabtivity-send.ps1` and the `.cmd` stubs are not checked by anything.
macOS-only: none.

## Not verified

- Anything live, on any OS. Packaging (deb fields, AppImage, NSIS, dmg), the
  updater against a renamed asset set, the desktop entries, the phone.
- `app_legacy_pids`: a fenced tab sees no host processes, so the guards'
  new branch was only syntax-checked.
- The French, Italian and Spanish dictionaries were corrected by pattern, not
  read in full by a speaker.
