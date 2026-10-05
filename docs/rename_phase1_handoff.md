# Rename phase 1 — done (2026-10-01); handoff to phase 2

Branch `rename`, worktree `.claude/worktrees/rename`. The plan is the untracked
`docs/rename_plan.md` (never `git add` it; the new name is secret and must not
appear in any tracked file or commit message).

**Phase 1 is complete.** No behaviour changed: every persisted or external
name keeps its value; only how the code spells it changed. The name is now
written in three places — `src-tauri/src/brand.rs`, `src/lib/brand.ts`, and
(read from the first) `scripts/lib/brand.sh` — and `scripts/brand-check.sh`
keeps it that way.

## Commits

- `764c83d3` phase 0.
- `08d89531` phase 1, Rust.
- `a1c4261c` phase 1, frontend + frontend tests. Its subject still says
  "WIP:" — it was not reworded (no rebase on this branch). Its tree was
  verified afterwards: only lint failed (next commit).
- `7a78ca7e` lint fix for the codemod scripts.
- `e16e9e9f` phase 1, mobile PWA + vite configs.
- `d7b5b63f` phase 1, scripts (`scripts/lib/brand.sh`).
- `29df9209`, `f27b1e72` `scripts/brand-check.sh` + CI job + AGENTS.md rule.
- The commit after those: this file.

Gates on the final tree: `npm run build` green; vitest 664 files / 6743 tests;
`cargo test` 3171 passed (lib 3003); lint 0 errors / 31 warnings (the
pre-existing ones); clippy `-D warnings` clean; `git diff --check`,
`privacy-check.sh`, `brand-check.sh` pass. Windows: lib **and** lib unit tests
type-check (`cargo check --target x86_64-pc-windows-msvc --lib --tests`, with
the msvc shims below). macOS cannot be compiled here (`objc2-exception-helper`
needs the Apple toolchain). **Nothing was run live** — the app was never
started.

## What phase 2 needs to know first

- `develop` has moved on since this branch was cut and was not merged. The
  merge will bring new hard-coded names; `scripts/brand-check.sh` lists them,
  and the codemods (below) convert them. Run all gates again after it.
- The denylist that is meant to block the new name
  (`<git common dir>/info/privacy-denylist`) holds one comment line and no
  entry: `privacy-check.sh` reports "0 denylist entries". The hooks do **not**
  block the name today. Add the entry (plan, "Enforce that") before anyone
  works with the name in this tree.
- Phase 2's test brand: flip `app_name!`/`app_slug!`/`app_upper!` in brand.rs
  and `BRAND` in brand.ts (use an invented one such as `Newname`). The
  `legacy_names_are_exactly_what_older_builds_wrote` test and `BrandMirror`
  then show what moved.
- Every dual read goes through the `LEGACY_*` twin that already exists; no new
  literal is needed, and `brand-check.sh` rejects one.
- The shell side has no dual read yet: `scripts/lib/brand.sh`'s
  `app_share_dir` and `app_env` are the two places to add "new, then old".
  It already exposes `APP_LEGACY_SLUG`.

## Conventions established

Rust (`src-tauri/src/brand.rs`):
- Literal macros `app_name!()`, `app_slug!()`, `app_upper!()`,
  `app_env!("TAB_UID")`, `app_tab_command!("mail")`, `app_repo!()` and
  `legacy_name!/legacy_slug!/legacy_upper!`. Consts `DISPLAY`, `SLUG`, `UPPER`,
  `ENV_PREFIX`, `REPO` and `LEGACY_*` forms.
- `names! { CUR / LEGACY_CUR = [slug, "-suffix"]; … }` declares every
  persisted/external name with its `LEGACY_*` twin. Test
  `legacy_names_are_exactly_what_older_builds_wrote` spells the old values out
  once (brand.rs is the only Rust file allowed to).
- Use sites: `crate::brand::X`; in format strings with inline captures
  `{SLUG}`/`{UPPER}`/`{DISPLAY}` with `use crate::brand::…`; elsewhere
  `concat!(…, crate::app_slug!(), …)`. Tests use the same (value-preserving).
- Serde keys stay literal in `#[serde(rename = "…")]`, preceded by a
  `// brand-check: allow — …` comment line and pinned by a test
  (`the_mobile_*_key_is_the_brand_constant`). The four `include_bytes!` paths
  of `scripts/eldrun-send.*` in `agent_bin.rs` carry the same marker (script
  names flip in phase 3).
- `storage::home_share_dir()` = `~/.local/share/<STATE_DIR_NAME>` regardless of
  the state-dir override: used by `dev_build.rs`, `ollama.rs`,
  `agent_session.rs`. NOT `state_dir()` on purpose — those paths deliberately
  ignore the override and are not the per-OS state dir on Windows/macOS;
  routing them through `state_dir()` would move data.
- Old-brand-only ids use `legacy_slug!()`: `paths::LEGACY_TRASH_PROJECT_ID`,
  `agent_home::LEGACY_STAGE_MOUNT`.
- Lib crate renamed `eldrun_lib` → `app_lib` (Cargo.toml `[lib] name`).
- Tauri command `local_tmux_kill_eldrun_sessions` → `local_tmux_kill_app_sessions`
  (frontend caller renamed in the same commit).
- `app_update.rs` test fixtures (signed sums, asset names) left byte-identical.
- `BIN_NAME` is held to `Cargo.toml`'s `[[bin]] name` by
  `the_bin_name_is_the_manifests`.

Frontend and phone (`src/lib/brand.ts`, imported by `mobile-web/` and the vite
configs too):
- `BRAND {display, slug, upper, envPrefix}`, `LEGACY_BRAND`, `NAMES` /
  `LEGACY_NAMES` (same keys, built by `namesFor(brand)`), `MOBILE_HOST_KEY` /
  `MOBILE_ACCESS_KEY` (literal-typed, used as computed keys `[MOBILE_HOST_KEY]`),
  `storageKey("x")` (`<slug>.x`), `storageDashKey`, `storageColonKey`,
  `envName("TAB_UID")`, `tabCommand("mail")`, `fillBrand` (fills `{app}` and
  `{slug}` in dictionaries).
- `BrandMirror.test.ts` + `helpers/rustBrand.ts` hold every shared `NAMES` key
  to brand.rs (camelCase key ↔ UPPER_SNAKE const), and the static files that
  must spell a name themselves to the brand module: `index.html`'s pre-paint
  storage keys, the phone's `sw.js` (cache prefix, message type, notification
  tag prefix), `mobile-web/index.html` and `manifest.webmanifest`.
- Code-only names went neutral: DOM events `eldrun:*` → `app:*`, CSS
  `--app-scrollbar` / `data-app-scrollbar` / `.app-scrollbar-*`, print classes
  `app-print-hidden` / `app-rot-*` / `app-copy-break`, `app-icon`,
  `__APP_PERF__`, `AskAppPage` (file renamed), i18n keys `…askApp`,
  `…startsWithApp`, `stats.metricAppOpen`, `fileTree.appNativeGroup`, untested id
  `desktop.intro.askApp`, `UriOrigin` value `"app"`. Phone: `AppMark.tsx`
  (file renamed), vite defines `__APP_MOBILE_COMMIT__` / `__APP_MOBILE_BUILT_AT__`,
  service-worker placeholders `__APP_BUILD__` / `__APP_ASSETS__`, vite/postcss
  plugin names `app-*`.
- Value kept via brand (persisted or crosses to the backend): localStorage keys,
  tab commands, env names, headers `x-<slug>-path`, `<slug>:file-drag-ended`,
  trust/print sentinels, tmux prefix, project dirs, export extension; phone:
  IndexedDB names, `<slug>.mobile.*` keys, the dashed keys `markup-pen` and
  `show-untested-tags`, the subprotocol, the WebAuthn user name
  `<slug>-mobile`, the `sw.js` → page message `NAMES.mobileOpenMessage`.
- `.eldrun_colors.json` (python-era hidden file) is pinned to `LEGACY_BRAND`.

Shell (`scripts/lib/brand.sh`, sourced):
- Reads the name's forms from brand.rs (`macro_rules! app_name` …) and the
  binary's name from `src-tauri/Cargo.toml` `[[bin]]`. Sets `APP_DISPLAY`,
  `APP_SLUG`, `APP_UPPER`, `APP_LEGACY_SLUG`, `APP_ENV_PREFIX`, `APP_BIN_NAME`,
  `APP_DEV_BIN_NAME`, `APP_SHARE_DIR`; functions `app_share_dir`,
  `app_env NAME [default]` (= `${<PREFIX>NAME:-default}`), `app_export NAME VALUE`.
  An unreadable name is an error and `return 1` — never a guess.
- Used by `backend-stale.sh`, `guard-single-instance.sh`, `package-dev.sh`,
  `package-dev-auto.sh`, `package-local.sh`, `retain-dev-build.sh`,
  `crash-symbolize.sh` and the three root launchers `start-eldrun-*.sh`. Those
  have no hit outside comments. Script files were not renamed.
- brand.rs test `the_shell_helper_reads_the_same_names` (Linux) sources the
  helper and compares every value with the Rust constants.
- Works under gawk and mawk (CI's awk).

`scripts/brand-check.sh`:
- Looks for the lowercase name (current and legacy, read from brand.rs) in
  every tracked text file and tracked path, case-insensitively. Lets through:
  the commented `ALLOW` list, a line with `brand-check: allow` or the line
  after it, and comments (`COMMENTS_ARE_PROSE=1`; set it to 0 after the
  phase-3 prose sed). `--list` prints what each allowlist entry still covers
  and flags entries that cover nothing.
- CI job `brand`, next to `privacy`; the three package jobs wait on it. No git
  hook runs it. AGENTS.md lists it with the gates and states the rule.
- Allowlist categories (each entry is commented with its phase in the script):
  the two brand modules (stay); prose — `*.md`, `docs/*`, licence files,
  `src/lib/untested.ts` (phase 3 sed); frozen texts — `app_update.rs`
  fixtures, `test-fixtures/`, `src/__tests__/fixtures/`,
  `src-tauri/tests/fixtures/` (stay); flip points — both `Cargo.toml`s,
  `Cargo.lock`, `package.json`, `package-lock.json`, `tauri*.conf.json`,
  `capabilities/`, `gen/`, `entitlements.plist`, `index.html`, the phone's
  `index.html` / `terminal-preview.html` / manifest / `sw.js`, `*.svg`,
  `privacy-reviewed-binaries.txt` (phase 3); files named after the app — the
  three launchers, `scripts/eldrun-send.*`, `scripts/eldrun-dev.cmd`, the
  screenshot (phase 3); tooling that cannot source the helper — `.githooks/`,
  `.github/`, `docker/`, `.gitignore`, `eslint.config.js` (phase 3);
  `scripts/rename-codemods/` (removed when the rename ends).
- **Still allowlisted although phase 1 could in principle have cleaned it:**
  `scripts/install_phone.sh`, `install_phone.ps1`, `take-screenshot.sh`,
  `copilot-probe.py`, `parse-qa.mjs`, `release-signing-keygen.sh`,
  `bump-version.sh`, `privacy-check.sh`. They spell a state dir, a settings
  key, a config dir or message text themselves. `install_phone.*` read the
  state dir and the `<slug>_mobile_host` settings key: phase 2 must give them
  the old-name fallback (the `.sh` one can source the helper; the `.ps1` one
  cannot).

## Pitfalls found

- Hand edits are the risky part: one slip (`.eldrun/` lost its dot in
  `GITIGNORE_DEFAULT`) was caught only by an integration test. Codemods are
  value-preserving by construction; prefer them.
- Phase 0 left two Windows-only `format!(concat!(… "{e}" …))` in `openvpn.rs`
  that did not compile for Windows (inline captures cannot live in `concat!`);
  fixed in the Rust commit. Always run the Windows type-check:
  `RC="$HOME/.local/bin/eldrun-msvc-rc-shim" AR_x86_64_pc_windows_msvc="$HOME/.local/bin/eldrun-msvc-lib-shim" cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib --tests`
- `vi.mock`/`vi.hoisted` factories are hoisted above imports: a brand import
  used at factory-evaluation time throws. The TS codemod skips and reports
  those; fix by hand (neutral fixture value, or use inside a later callback).
- `git diff > patch` of the tests does not re-apply (one test file is treated
  as binary). To separate test changes, regenerate with the codemod instead.
- Renaming the Tauri command means a hot-reloaded frontend on a stale backend
  fails that call until the app restarts (`npm run backend:stale` reports it).
- A new gate script must be run **after** `git add`: `brand-check.sh` passed
  while untracked and failed on its own allowlist once tracked (`f27b1e72`).
- The dev launcher `start-eldrun-dev-build.sh` ends in `exec "$BINARY"`: never
  run it to test it. It was compared with its old version with the `exec`
  replaced, `HOME` redirected and `pgrep`/`notify-send` stubbed; only the
  "no build installed" path ran. Its adopt-a-newer-snapshot path was reviewed
  by diff, not executed.

## Edits inside non-Linux `cfg` code (whole phase 1 diff)

Windows-only, type-checked for `x86_64-pc-windows-msvc` (lib and lib tests),
never run:
- `commands/mobile_control.rs`: `HOST_BINARY_NAME`, `RUN_VALUE`,
  `start_installed_host`'s two `.join(HOST_BINARY_NAME)`, and the
  `cfg(all(test, windows))` `run_command_line` test.
- `commands/presenter.rs`: the keep-awake thread's name.
- `platform/windows.rs`: `make_sticky` parameter renamed to `_app_pid`.
- `services/agent_bin.rs`: the `.cmd`/`.ps1` shim names and include paths.
- `services/agent_hint.rs`: `SCRIPT_NAME` (ps1).
- `services/agent_session.rs`: `HOOK_SCRIPT_NAME` (ps1),
  `container_hook_script_path`'s `.join(SESSION_HOOK_SH)`, the PowerShell hook
  body (`{DISPLAY}` / `{UPPER}_TAB_UID` … captures), and its `cfg(windows)`
  test.
- `services/mobile_control/admin.rs`: the control pipe's name.
- `services/openvpn.rs`: two error format strings (`{app}` argument).

macOS-only, **not compiled** (read only):
- `commands/mobile_control.rs`: `LAUNCHD_LABEL`, and the
  `cfg(all(test, target_os = "macos"))` `launchd_plist` test.
- `platform/macos.rs`: `make_sticky` parameter renamed to `_app_pid`.
- `services/agent_fence.rs`: the `<PREFIX>AGENT_FENCE` variable set in the
  macOS fence's environment (`app_env!`).

Compiled and tested on Linux although they serve another OS (cfg-free on
purpose): `lib.rs` `MAC_MENU_QUIT_ID` (`cfg(any(macos, test))`),
`platform/windows_park.rs`, `platform/macos_park.rs`, the askpass shim bodies
in `services/ssh_common.rs`, every `cfg!(…)` expression.

## Gaps found in Phase 1

Persisted or external names that the plan's migration table does not cover,
or covers wrongly. Each was confirmed in the code; none is fixed here.

1. **VM instance id** (`services/vm.rs:1091-1098`, `seed_instance_id`). The
   plan says existing VMs keep stored values. The id is not stored: it is
   computed at every boot as `<VM_INSTANCE_ID_PREFIX><project id>-<hash of
   user-data>`. A flip changes the prefix, and it changes the hash too,
   because the user-data itself names the app (`vm.rs:1049,1058`:
   `/etc/profile.d/<slug>-proxy.sh`, `apt.conf.d/95<slug>-proxy`, plus the
   guest user and mount path). cloud-init would run first boot again in every
   existing VM. Phase 2 must pin existing VMs to the legacy names, or store
   the id.
2. **VM names beyond the three in the plan**: `VM_PROJECT_DIR`
   (`/home/<slug>/project`, stored as the project's `remote_path`,
   `commands/projects.rs:3832`), `VM_BASE_IMAGE_PREFIX` (cached base image
   file names, `vm.rs:116-117`; after a flip the cached base is no longer
   found under its name).
3. **Hashed ids**: `GATEWAY_ID_CONTEXT` (`commands/workspace.rs:562`) is
   hashed into the id of every remembered network — a flip forgets them all.
   `SUBAGENT_TOKEN_CONTEXT` (`services/agent_transcript.rs:270`) is hashed
   into the handles the phone holds for subagents.
4. **Project folders** `<slug>-screenshots` and `<slug>-emails`
   (`commands/projects.rs:2914-2918`, `.gitignore`): not in the table; they
   sit in user projects and in their ignore rules.
5. **Agent-hint artefacts** (`services/agent_hint.rs:48,113-122`): the hook
   scripts `<slug>_agent_hint.{sh,ps1,md}`, the `<!-- <slug>:agent-hint:… -->`
   block markers in each CLI's instructions file, and Copilot's
   `.copilot/hooks/<slug>-hint.json`. The table has the session hook and the
   box-links markers only. Also the Vibe hook entry name `<slug>-session`
   (`agent_session.rs:1801-1817`, `agent_global.rs:680`).
6. **Lockstep bundle** `.git/<slug>-lockstep.bundle`
   (`services/git_peer.rs:1244-1247`): the table has the worker bundle only.
7. **Windows control pipe** `\\.\pipe\<slug>-control-<hex>`
   (`services/mobile_control/admin.rs:199`): a running old host and a new
   window would not find each other. The host-swap step must cover it.
8. **HPC anchor default** `<slug>/<project>` relative to the cluster home
   (`src/lib/remote/hpc/hpcWorkspace.ts:273`): new anchors would land in a
   new folder; whether existing projects store their anchor must be checked.
9. **ICS UIDs** `<row id>@<slug>` for events without a UID
   (`src/lib/calendar/ics.ts:668`): a flip changes the UID of every such
   event on the next export, which an importer reads as new events.
10. **localStorage keys that are not `<slug>.*`**: the table's step copies
    `eldrun.*` only. There are also dashed keys (`storageDashKey`: theme,
    accent, theme-vars, corners, lang, …, 12 call sites; `index.html`'s
    pre-paint script reads four of them) and colon keys (`storageColonKey`,
    4 call sites).
11. **Phone service worker ↔ page**: the message type `<slug>-open` and the
    notification tag prefix `<slug>-` (`mobile-web/public/sw.js:118,145`,
    `App.tsx`). Page and worker update at different moments, so across the
    flip a tapped notification will not navigate until both are new. Also the
    WebAuthn credential's user name `<slug>-mobile` (`localLock.ts:160`):
    existing passkeys keep the old label.
12. **Dev tooling state** (scripts, per user): git config key
    `<slug>.autoDevBuild`; the sandbox dir `~/.local/share/<slug>-dev`;
    retained builds `dev-builds/<slug>-<commit>`; the desktop entries
    `<Display>.desktop` and `<Display>HotReload.desktop` (the table names only
    the `Dev` one); `~/.config/<slug>-release-signing` and
    `~/.config/<slug>/privacy-denylist`; the `.git/<slug>-release-signing-secret-ok`
    marker (`.githooks/pre-push:45`).
13. **Already changed in phase 1** (small, one-time): the stored intro page id
    `askEldrun` became `askApp` — a stored last-page of the old id falls back
    to the first page once (`src/components/layout/intro/introData.ts`).
14. **Process**: the privacy denylist does not contain the new name (see
    "What phase 2 needs to know first").

Checked and fine: `MOBILE_AUTH_CONTEXT` is part of a challenge the host
itself builds and the phone signs as given (`mobile_control/auth.rs:334-338`),
so only a challenge in flight at the flip is lost.

## Codemod scripts

`scripts/rename-codemods/` — **keep until the phase-3 flip has landed**, then
delete it and its `brand-check.sh` allowlist entry. Reason: `develop` has to
be merged into this branch, and every later merge until the flip can bring
new hard-coded names; the codemods are how they are converted without hand
edits.
- `rslex.py` (Rust lexer + counts), `rshits.py prod|test` (non-comment hits),
  `rsmod.py [--dry] files…` (the Rust codemod), `flatten.py` (un-nest
  `concat!`), `edit.py spec.py` (exact replacements with expected counts).
- `tshits.mjs [--tokens] files…` (non-comment TS/TSX hits via the TS AST),
  `tsmod.mjs [--dry] files…` (the TS codemod; prints what it left; knows the
  phone's names too).
- `vt.sh` (vitest → totals + failures only; writes JSON to
  `/tmp/rename-scratch`, create that dir first).
Run the `.mjs` scripts from the repo root (they use `process.cwd()` and the
repo's `typescript`).
