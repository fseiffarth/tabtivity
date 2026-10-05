# Rename Eldrun → Tabtivity — plan

Status: plan only — nothing implemented. Third revision, 2026-10-01: changed
from "keep old names forever" to a **full replacement** in two releases (see
"Approach"). The two earlier code reviews built the inventory below; their
notes are under "History" at the end. Name chosen 2026-10-01 (see "Name").

## Name

**Tabtivity** (tab + productivity), pronounced "tab-TIV-ity". Forms: display
`Tabtivity`, slug `tabtivity`, env prefix `TABTIVITY_`.

- **Why the rename:** nobody knows how to say "Eldrun" (ELD-run? EL-drun?
  "roon"?), so the name trips people up whether they read it or hear it.
  "Tabtivity" has one obvious reading in English and German.
- **Why this name:** in this app the tab is the unit of everything. Each
  project is a tab, and inside it every agent, terminal, file, mail and viewer
  is a tab. The name names that idea; the product keeps tab chaos organized by
  project.
- **Tagline:** *"A tab for each project. A tab for everything in it."* Show it
  next to the name wherever possible, because the bare name reads like a
  browser-tab extension.
- **Availability (checked 2026-10-01 via registry RDAP and APIs):**
  tabtivity.com, .app and .dev were unregistered, and the GitHub user/org,
  npm and crates.io names were free. No product used the name (web search).
  The only similar name is Tabtify, an unrelated guitar-tab tool.
- **Language check:** not a bad word anywhere we know of. In Danish, *tabt*
  means "lost", so Danes may read it as "lost-ivity". We accept that.
- **Before anything public:** register the domains and the GitHub org, and run
  a trademark search (EUIPO TMview, USPTO). Until then the name stays out of
  public commits. This plan file is the one exception, so commit it only once
  the name is secured.
- **Enforce that:** add `Tabtivity` to the untracked
  `.git/info/privacy-denylist`, so the hooks block an accidental `git add -A`
  from any session sharing this tree. Remove the entry at the flip.
- **Repo owner (decided 2026-10-01):** the repo stays under `fseiffarth/` and
  is renamed in place. The org is registered anyway, to reserve the name, and
  the updater bridge accepts both owners so a later move strands no client
  (see Phase 0). An owner goes into the bridge only once we control it. If the
  org name cannot be had, the bridge ships with `fseiffarth` only.
  **Decided 2026-10-01:** the Phase 0 bridge keeps `fseiffarth` as the only
  owner for now (`RELEASE_OWNERS` in `app_update.rs`).
- **Order this forces:** the org name in the bridge puts the new name into a
  public commit. So register the org and domains and run the trademark search
  before Phase 0 ships. To ship the bridge earlier, use `fseiffarth` only.

## Approach: full replacement, expand then contract

Every "eldrun" goes: names on disk, in the keyring, in protocols, in agent
configs, in the code. Two releases do it.

- **Release A (expand):** the brand flips to Tabtivity, and a **migrator**
  runs at startup. It moves each old-named thing to its new name. Wherever
  something is looked up, the new name is tried first and the old name second.
  Everything is written under the new name only.
- **Fallback log:** every time an old-name lookup actually finds something,
  `brand::legacy_hit("<id>")` counts it in `<state>/legacy-hits.json`
  (`{id: {count, first, last}}`). The phone host logs old protocol names the
  same way. Settings → About shows the file's summary.
- **Release B (contract):** when the log has stayed empty on every machine you
  use (desktop, laptops, phone, remotes) for a few weeks, delete every
  old-name lookup. All old names are `LEGACY_*` constants, so the cleanup
  starts with deleting the constants and fixing what no longer compiles.
  `brand-check.sh` then rejects any `eldrun` outside the allowlist.

**Fresh installs use only Tabtivity, from release A on.** The migrator and the
fallbacks only *look* for old names; nothing ever *creates* one. A fresh
install gets `~/.local/share/tabtivity`, `~/tabtivity`, `.tabtivity/` in
projects, `tabtivity-*` keyring services, `refs/tabtivity/*`, and so on. A
test enforces it (see Verification).

**What survives release B, on purpose:**
- the migrator itself (~one module). It only runs when an old folder exists,
  so someone who skips release A still gets their data moved;
- importing old `.eldrunproj` bundles and old `eldrun-export.json` manifests,
  because exports sit in backups for years;
- prose that tells the history ("formerly Eldrun") in the README and changelog.

## Context

"Eldrun" appears ~9,000 times in 893 tracked files. Most of it is prose and
code identifiers. Several dozen hits, though, are built into **persisted or
external state**:

- absolute paths inside `projects.json` and agent-home CLI configs
- a mobile host that runs from the state dir and outlives the desktop app
- the webview data dir, keyed on the Tauri identifier
- the mail store's key-derivation labels
- IndexedDB device keys on the phone
- git refs on peers and live tmux sessions on remote hosts
- MCP tool names in agent allowlists
- the updater's repo URL

A blind `sed` would orphan user data and break upgrades. The migration table
below gives each of these its own step.

**Goals:**

- (a) Do the risky groundwork first, with the brand still set to `Eldrun`.
- (b) Switch to Tabtivity with one reviewed commit
  (`scripts/brand-flip.sh Tabtivity tabtivity`); that release (A) carries the
  migrator.
- (c) Existing installs upgrade without losing anything. Each migration step
  copies first, switches, verifies, and deletes the old copy only after that.
- (d) After release B, no code path knows the old names except the migrator.

## Decisions

1. **One source of truth.** The three forms (display, slug, env prefix) live
   in `src-tauri/src/brand.rs` and `src/lib/brand.ts`. `mobile-web` imports
   the TS module or keeps a twin. Every old name becomes a named `LEGACY_*`
   constant in the same modules, never a bare literal. Until the flip, the
   current values stay `Eldrun`/`eldrun`.
2. **Everything is renamed.** Nothing keeps the old name for good; the
   migration table says how each item moves.
3. **The migrator is one module,** `services::brand_migration`, `AppHandle`-free
   and unit-testable like every `services/` module.
   - It runs at the top of `run`, before the webview context is built
     (`lib.rs:1051` already does WebKit-dir work there) and before the mobile
     host is started.
   - Each step is idempotent and recorded as done in
     `<state>/migrations.json`. A crash mid-step re-runs that step.
   - Each step copies, verifies and only then removes the old copy. Steps that
     drop git refs or files in projects record through `services::local_loss`.
   - Steps that need something absent at startup (a mail-store unlock, root for
     the Ollama drop-ins, a live SSH session) run lazily at the first moment it
     is present, and stay pending in `migrations.json` until then.
   - It never edits a file inside a project folder except Tabtivity's own
     `.eldrun/` folder, its `info/exclude` line and its worktree links, which
     Eldrun created there.
4. **Safety nets for the old state dir.** After moving
   `~/.local/share/eldrun`, the migrator leaves a symlink (a junction on
   Windows) at the old path pointing to the new one. Absolute paths the
   migrator missed and pre-A builds keep working. Release B removes the link
   only after a scan finds no old prefix in any known path holder.
5. **Code-only identifiers become brand-neutral,** so a future rename never
   touches code again:
   - `eldrun_home()` → `app_home()`
   - `eldrun:open-settings` → `app:open-settings`
   - `--eldrun-scrollbar` → `--app-scrollbar`
6. **The new name is not persisted before the flip.** Phases 0–2 ship with
   slug `eldrun`. Before release A, the `tabtivity` slug runs only in tests and
   in a throwaway sandbox
   (`ELDRUN_STATE_DIR` + `ELDRUN_HOME` via `start-eldrun-dev-sandbox.sh`).
7. **Pre-A builds are unsupported after migration.** Thanks to the symlink they
   find the state dir, but their UI state (old webview dir) is a stale copy.
   The frozen dev build is built from the same tree, so it is on A as soon as
   the flip commit lands.

## Migration table (release A moves it, release B drops the old name)

"Dual read" means: try the new name, then the old one, and log a hit.

| Identifier | Where | Release A | Release B |
|---|---|---|---|
| State dir `~/.local/share/eldrun` (`%APPDATA%\eldrun`, mac App Support) → `tabtivity` | `storage.rs:220` `state_dir()` | Move the dir, leave the symlink (decision 4). Rewrite the absolute paths that point into it: `projects.json` remote projects (`<state>/remote-projects/<id>`, `projects.rs:1139,4505`), archive manifests, agent-home hook entries. Stop the mobile host first; on Windows its `.exe` locks the dir. | Scan the path holders for the old prefix; if clean, remove the symlink. |
| `~/eldrun` tree → `~/tabtivity` | `paths.rs:592` `app_home()` | Fresh installs: `~/tabtivity`. Existing installs: keep using `~/eldrun` (resolution: `~/tabtivity` if it exists, else `~/eldrun` if it exists, else create `~/tabtivity`). Moving it is the separate, optional Phase M. | The `~/eldrun` branch stays until Phase M has run on every machine; then it goes, and so does the link Phase M leaves at `~/eldrun` once a holder scan is clean. |
| Webview data dir `<data>/io.github.fseiffarth.eldrun` (all localStorage, IndexedDB) | Tauri identifier in `tauri.conf.json`; `lib.rs:1045-1053` | New identifier `io.github.fseiffarth.tabtivity`. Before the webview context exists, copy the old data dir to the new one if the new one is absent. Linux path known; Windows (WebView2) and macOS paths *unverified* — check per OS. | Delete the old data dir. |
| localStorage keys `eldrun.*` (desktop + PWA) | ~33 files | On first load, copy every `eldrun.*` key to `tabtivity.*`, then delete the old key. One shared helper for desktop and PWA. | Delete the helper. |
| Mail key-derivation labels `eldrun/mail/v1/{field,blob,addr,name,wrap}`, wrap AAD `eldrun/mail/v1/master` | `mail_crypt.rs:374-378,441` | **Highest-risk step: data loss if wrong.** The labels are key inputs. New stores use `tabtivity/mail/v1/…`. The store records which label set it uses. An old store is re-encrypted at the next unlock: back it up, re-encrypt under the new labels, decrypt every record again to verify, then switch. The backup stays until release B. | Remove the old label set once no store reports it, and delete the backups. |
| HKDF salt `eldrun-mobile-files` | `mobile_control/files.rs:131` | New tokens use the new salt; unsealing tries both. | Old salt goes; any old token left has expired or is re-issued. |
| Agent-home markers `.eldrun-home`, `.eldrun-global.json`, backup `.eldrun-global-backup` | `agent_home.rs:36`, `agent_global.rs:49,51` | Rename the files in every agent home; dual read. Without the marker a home counts as fresh and is seeded again, so the rename comes before any spawn. | Drop the old names. |
| Hook script `<state>/hooks/eldrun_session_start.sh` | agent homes, `agent_session.rs:2133` | Rename to `tabtivity_session_start.sh`. Rewrite the hook entries in Eldrun's own agent homes. `is_eldrun_hook` (`agent_global.rs:595`) matches the old and the new hooks dir, so old entries are recognised and replaced, not left dead. | Match only the new dir. |
| MCP server names `eldrun`, `eldrun-git`, `eldrun-help`, `eldrun-schedule`; tool names `eldrun_help_*` etc. | `*_mcp.rs` `SERVER_NAME`, `root_mcp.rs:69`, policy table `root_mcp_security.rs:343`, `VIBE_ENABLED_TOOLS` globs | Register the new names only. The spawn-time merge rewrites allow rules in agent homes and the Eldrun-wide layer (`mcp__eldrun-git__git_push` → `mcp__tabtivity-git__git_push`). The policy table and globs list both names. Allow rules inside projects' own `.claude/settings.local.json` are not ours to edit: those projects re-prompt once, and the release notes say so. | Policy table and globs list only the new names. |
| Box-links markers `<!-- eldrun:box-links:start/end -->`, `.eldrun-box-links.json` | `boxes.rs:16,37` | Read both markers; replace an old block in place with a new one; rename the json. A synced peer still on a pre-A build would append a second block, so update all machines together. | Read only the new marker. |
| Persisted serde keys `eldrun_mobile_host`, `eldrun_mobile_access` | `settings.rs:783`, `boxes.rs:57`, `projects.rs:2091`; the sidecar reads them raw (`discovery.rs:483`) | `#[serde(alias = …)]` on read, new key on write; the sidecar reads both. | Remove the aliases. |
| Saved tab commands `__eldrun_files__`, `__eldrun_mail__`, …, timer id `__eldrun__` | `terminal_service.rs:234-245`, `tabs.ts:219`, `timer.rs:5` | Map old to new on load; save new. | Remove the mapping. |
| Keyring services `eldrun-remote`, `eldrun-git-hosting` | `remote_credentials.rs:22`, `git_credentials.rs:17` | Copy each entry to `tabtivity-*`; dual read. Keep the old entries (older builds on the same machine). A locked keyring postpones the step; it never prompts. | Delete the old entries. |
| Mobile host binary `eldrun-mobile-host`, systemd unit `eldrun-mobile-host.service`, launchd label `io.github.fseiffarth.eldrun.mobile-host`, Windows Run value `EldrunMobileHost` | `mobile_control.rs:281,453,544,587,853,997` | One step: stop the old service, install the new binary and unit/label/Run value, remove the old ones, start the new one. Pairing survives (see PWA rows). | — |
| PWA IndexedDB `eldrun-mobile-auth` (device key), `eldrun-mobile-markup` (unsaved markup); SW cache `eldrun-mobile-shell-*` | `mobile-web/src/auth.ts:4`, `markup/store.ts:28`, `public/sw.js:12` | Same origin, so the new PWA copies both databases to `tabtivity-*` on first start, verifies, then deletes the old ones. **No re-pair needed.** The SW deletes the old cache on activate. | Remove the copy code. |
| WebSocket subprotocol `eldrun-terminal.v1`, cookie `__Host-eldrun_session`, headers `x-eldrun-*` | `mobile_control/protocol.rs:25`, `host.rs:183,483` | The host accepts both and logs old ones; the new PWA sends only new names. A cached old PWA keeps working. | The host accepts only new names. |
| In-project `.eldrun/` (inbox, outbox, worktrees, scaffold), its `info/exclude` line, remote `.eldrun-worker.bundle` | `fs.rs:125,2130,2162`, inbox/outbox code, `git.rs:3192`, `worker_sync.rs:38` | Per project, lazily at first open: rename `.eldrun/` → `.tabtivity/`, run `git worktree repair` for worktrees inside it, update the exclude line. Remote projects: the same over SSH at the next connect. The next worker sync writes the new bundle name and deletes the old file. | Drop the `.eldrun/` lookup. |
| Export manifest `eldrun-export.json`, extension `.eldrunproj` | `project_transfer.rs:91` | Export writes the new names; import accepts both. | Import keeps accepting both (see "What survives"). |
| git refs `refs/eldrun/{backup,peer,incoming}` | `git_peer.rs`, `projects.rs:1203` | Local: copy to `refs/tabtivity/*`, then delete the old ones (through `local_loss`). Peers and remotes: the next sync pushes the new refs and deletes the old ones. Dual read until then. | Drop the old namespace. |
| tmux names `eldrun-p…--agent-…` | `discovery.rs` `expected_tmux`, terminal | New sessions use the new prefix. Discovery matches both, so running remote sessions reattach. They end under their old names. | Match only the new prefix; the log shows when no old session was seen any more. |
| Docker labels `eldrun.owner=eldrun`, `eldrun.project=`, `eldrun.spec=`; image `eldrun-agent-sandbox:latest` | `sandbox.rs:108,116,260` | New containers get new labels; the startup sweep matches both. `docker tag` the old image to the new name, so nothing rebuilds. | Match only new labels; remove the old image tag. |
| VM names `eldrun-vm`, guest user `eldrun`, cloud-init `instance-id: eldrun-1` | `vm.rs:62`, `projects.rs:3829`, `iso9660.rs:240` | Only the defaults for new VMs change. Existing VMs keep the values stored in their project records; they are data, not lookups. **Never change an existing instance-id:** cloud-init would treat the VM as new and run first boot again. | Nothing to drop. |
| Ollama drop-ins `/etc/systemd/system/ollama.service.d/eldrun-{igpu,models}.conf` | `ollama.rs:2436,2568` | They need root, so the step waits until the user next changes a setting that writes them (that already asks for root). It then writes the new names and removes the old files. Dual read until then. | Drop the old names. |
| Dev launcher `EldrunDev.desktop`, dev scripts `start-eldrun-*.sh`, `eldrun-dev.cmd` | repo root, `scripts/`, `dev_build.rs:456` | Rename the scripts at the flip, keeping one-line forwarding stubs. Rewrite the installed launcher (Eldrun's own file). | Delete the stubs. |
| CLI shims `eldrun-send` etc. | `scripts/eldrun-send.*`, shim install, the SessionStart hook text | Ship `tabtivity-send`; keep the old name as an alias that logs a hit. Update the hook text and agent docs to the new name. | Remove the alias. |
| Env vars `ELDRUN_*` (~60) | backend, scripts, shims, `.githooks/pre-push:167` | Export both; read new, then old, through `brand::env(..)`. Change this repo's hooks to the new names. | Stop exporting the old names. External user scripts can't be logged, so the release notes for B list the renamed variables. |
| Crate `eldrun_lib` | `Cargo.toml` | Rename at the flip; nothing persists it. | — |

## Rename table (no migration needed)

| Identifier | Where | Treatment |
|---|---|---|
| Display text | `src/lib/i18n.ts` (440 lines) + 4 dicts in `src/lib/i18nDicts/` (~425 each); hardcoded Rust notifications and errors, window title; ~70 hardcoded strings in `mobile-web/src` (e.g. `Home.tsx:79,288-290`); `mobile-web/index.html`, `public/manifest.webmanifest`, `icons/icon.svg` | Through `BRAND.display`; i18n through `{app}` (Phase 0). |
| `productName`, deb package name, NSIS install, macOS bundle | `tauri.conf.json` | Old and new must not end up side by side. Add deb `Conflicts/Replaces/Provides: eldrun`. Add an NSIS pre-install hook that uninstalls the old product. *Unverified:* whether Tauri's NSIS keys the uninstall entry and install dir on `productName`. macOS has no installer step: `Tabtivity.app` lands next to `Eldrun.app`, so the release notes tell users to delete the old one. An AppImage is swapped in place and keeps its file name. |
| Main binary `eldrun` | `Cargo.toml` `name`, `default-run`, `[[bin]]` | Flip point. Window-protect lists (`x11.rs`, `windows_park.rs`, `macos_park.rs`) hold both names until release B. `.desktop` `Exec`/`StartupWMClass` updated. *Unverified:* Tauri 2's `mainBinaryName`. |
| User agents `Eldrun/<ver>`, `Eldrun-CalDAV/1.0`, `eldrun-spell`, `Eldrun Reader`, `User-Agent: Eldrun` | `app_update.rs:48`, `copilot_auth.rs:239`, `git_ci.rs:90`, `caldav.rs:71`, `spell.rs:481`, `browser_engine.rs:138`, `ollama.rs:1714` | Build them from `brand` (Phase 0). No server keys on them. |
| Updater repo + VAPID subject | `app_update.rs:36-53`, `mobile_control/push.rs:58`, `ci-cd.yml`, `release-signing-keygen.sh` | Phase 0 bridge, then Phase 4. |
| Prose | `README.md`, `DOCUMENTATION.md`, `docs/`, `docs/help/` (served by the help MCP), `todo/`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` | Sed at the flip. |

## Phases

### Phase 0: ship now (no visible change)
- **Updater bridge.** `is_repo_download_url` (`app_update.rs:417`) accepts any
  `https://github.com/<owner>/*/releases/download/` URL; the signed
  `SHA256SUMS` stays the trust anchor.
  - `<owner>` is `fseiffarth` or the registered org (see "Repo owner" under
    "Name"). The list is final once shipped: a client with the wrong owner
    list rejects every later release.
  - `*` matches exactly one path segment (no `/`, not `.` or `..`).
  - `LATEST_API` (`app_update.rs:40`) is hardcoded too. It keeps working after
    a rename only through GitHub's redirect, and a transfer to an org
    redirects the same way. Add a unit test that the client follows a 301.
  - It ships first so it has the longest time to reach users before the repo
    rename.
  - Asset names need no change: `pick_asset` chooses by extension and arch,
    never by the `Eldrun_` prefix (`app_update.rs:250-282`).
  - Clients that skip it update by hand after the rename.
- Add the brand modules from decision 1.
- `{app}` in the dictionaries is filled from `BRAND.display`. Preferred: do it
  once where a dictionary is loaded, so `translate()` (`src/lib/i18n.ts:8454`)
  stays untouched. If the dictionaries have no single load point, patch
  `translate()` instead; that must cover the `if (!params) return raw;` early
  return at `:8460`, or strings show a literal `{app}`. No existing key uses
  an `{app}` param.
- Codemod `Eldrun` → `{app}` in the en dictionary and the 4 others. Check
  genitives (`Eldruns`) by hand. Key names like `askEldrun` become
  brand-neutral in Phase 1.
- Move the hardcoded display text listed above, including mobile, to
  `BRAND.display`. Build the user agents from `brand` as well.

### Phase 1: neutralize code-only identifiers (no visible change)
- Do mechanical renames per decision 5, one commit per area (Rust, frontend,
  mobile, scripts, tests):
  - fn and var names, i18n key names
  - DOM events, CSS vars, `data-eldrun-*`
  - temp-file prefixes
  - test fixtures
- Turn every old name in the migration table into a `LEGACY_*` constant, and
  its new twin into a `brand` constant. No behaviour changes yet.
- Route hardcoded state-dir paths through `state_dir()`:
  - `agent_session.rs:1822`
  - `services/dev_build.rs:197`
  - `ollama.rs:4107,4244`

  The shell scripts (`package-dev-auto.sh:63`, `package-local.sh`) get one
  sourced helper that resolves the state dir (new, then old).
- Route the built binary's name through one place. `target/{debug,release}/eldrun`
  and `eldrun.frozen` are hardcoded in `backend-stale.sh:58-69`,
  `guard-single-instance.sh:37`, `package-dev.sh:209`, `package-local.sh:27`,
  `start-eldrun-dev-build.sh:42,79` and `dev_build.rs:593-594`. Add one sourced
  shell helper that reads the bin name from `Cargo.toml`, and a `brand`
  constant on the Rust side. A miss here breaks `backend:stale` and the
  post-commit frozen build without an error.
- Tests that assert the literal `"eldrun"` (`paths.rs:986`, `x11.rs:872`, …)
  assert `brand::SLUG` or `LEGACY_SLUG` instead.
- Frontend tests: 132 files under `src/__tests__` match on the text "Eldrun"
  (232 hits). Change the ones that match rendered text to `BRAND.display`.
- Add `scripts/brand-check.sh`: `rg -i eldrun` must hit only allowlisted paths
  (prose before the flip, `LEGACY_*` definitions, the migrator). It runs next
  to `privacy-check.sh` in CI.

### Phase 2: migration engine (no-ops while the slug is still `eldrun`)
- Build `services::brand_migration` (decision 3) with one step per migration
  table row, the dual reads, `brand::legacy_hit`, `brand::env`, and the
  fallback log.
- While `SLUG == LEGACY_SLUG` every step is a no-op, so this ships safely.
- Unit-test each step with a test brand where `SLUG != LEGACY_SLUG`, against
  a temp state dir and home seeded with real old-shaped data (including a mail
  store written with the old labels, an agent home with old hook entries, and a
  repo with a worktree under `.eldrun/`).
- Also build the deb/NSIS old-package replacement and the shim alias.

### Phase 3: release A — the flip to Tabtivity
- Gate: the domains and GitHub org are registered, and the trademark search is
  clean (see "Name"). Phase 2 has been run against a copy of a real state dir.
- Add `scripts/brand-flip.sh <Display> <slug>` and run it as
  `scripts/brand-flip.sh Tabtivity tabtivity`. It edits only the flip points:
  - `brand.rs` and `brand.ts`
  - `Cargo.toml` bin and crate names
  - `scripts/bump-version.sh:71`, which finds the Cargo.lock block by
    `name = "eldrun"`
  - `package.json`
  - `tauri.conf.json` `productName`, `title` and `identifier`
  - mobile `manifest.webmanifest` and `index.html`
  - desktop files
  - the dev-script renames and their stubs
  - `ci-cd.yml`: the dmg rename at `:451` (`Eldrun_${version}_universal.dmg`),
    the artifact names and the release-note text (`:516`, `:534`)
- Remove `Tabtivity` from `.git/info/privacy-denylist` first, or the hooks
  reject the flip commit.
- New icons and bitmaps need their blob ids in
  `scripts/privacy-reviewed-binaries.txt`.
- Then run the prose sed. German genitives become `Tabtivitys`; check the
  dictionaries by hand.
- Put the tagline in the README header, the About dialog, the `.desktop`
  `Comment`, the deb/NSIS description and the PWA manifest `description`
  (through i18n, like any display text).
- The logo mark stays (decided 2026-10-01): the ring, tree, six hex nodes
  and gold star are unchanged. Only the name text changes: the
  `aria-label`/`<title>` in `src/assets/logo*.svg`,
  `src-tauri/icons/icon-source.svg`, `mobile-web/public/icons/icon.svg`,
  `LogoIcon.tsx`, `mobile-web/src/EldrunMark.tsx` and the installer SVGs; the
  `logo-wordmark{,-white}.svg` text. In `installer/header.svg`, "Tabtivity"
  at 21px ends at ~152px of a 150px banner: shrink to ~18px or move it left,
  then regenerate `header.bmp`/`sidebar.bmp` and record their blob ids.
- Release notes: projects with their own MCP allow rules re-prompt once;
  macOS users delete `Eldrun.app`; update all synced machines together.

### Phase 4: external (after the Phase 0 bridge has been out a while)
- Rename the GitHub repo (target name `tabtivity` is still open); GitHub
  redirects the API and git URLs.
- Then:
  - flip the `REPO` constants
  - flip the VAPID subject (`push.rs:58`)
  - `git remote set-url`
  - update the badges and the `release-signing-keygen.sh` help text

### Phase M (optional, per machine): move `~/eldrun` to `~/tabtivity`

Status: plan only (2026-10-02). Nothing below is implemented.

#### Goal and scope
- A pre-release-A install keeps its tree at `~/eldrun` (`projects/`,
  `projects-ssh/`, `root/`, `boxes/`, `archive/`). `app_home_in`
  (`paths.rs:609`) resolves: env override, else `~/tabtivity` if it exists,
  else `~/eldrun` if it exists (legacy hit `home-tree`), else `~/tabtivity`
  (`resolve_named_dir`, `brand_migration/mod.rs:341`).
- Phase M moves the tree to `~/tabtivity` on one machine, when the user asks
  from a button. Afterwards projects, tabs, worktrees, containers, boxes,
  archive entries, exec approvals and agent conversations (`--resume`,
  "continue last", memory) all work as before, and `home-tree` stops counting.
- Out of scope: installs with `TABTIVITY_HOME` set (not offered), projects
  outside the tree, VM projects, other machines.

#### Findings: what the move flow covers today
There is no "move to another parent" flow. The "Migrate project" dialog
(`project_migration_plan/apply`, `commands/projects.rs:3819,3854`) only
repairs scaffold files. Two flows move folders. `rename_project_dir`
(`projects.rs:1598`) renames a closed local project's folder within its
parent; the store closes the project first (`stores/projects.ts:1585`).
`move_remote_mirror` (`projects.rs:2805`) moves a remote project's mirror.

| Holder | `rename_project_dir` | `move_remote_mirror` |
|---|---|---|
| `projects.json` entry, all string values (`storage::rewrite_path_prefix`, `storage.rs:401`) | yes (`:1618`) | `extra.mirror` only (`:2776`) |
| the project's `project.json` | yes, best effort (`:1642`) | `mirror` only |
| saved tabs `sessions/<key>/terminals.json` (`terminal_service.rs:260`) | yes (`:1658`) | **no** |
| linked worktrees (`git worktree repair`, `:1666,1687`) | yes, but bare `git`, not `hookless_git_command_in` (`git.rs:471`) | **no** |
| worktrees inside the folder that belong to a repo outside it | **no** | **no** |
| local tmux sessions | indirectly: closing kills them (`stores/projects.ts:1459-1494`) | n/a |
| project container | indirectly: mounts are in the spec fingerprint, so the next `up` recreates it (`sandbox.rs:177-215,894`); its writable layer is lost | n/a |
| `.tabtivity/` inbox, outbox, worktrees | yes (they are inside the folder) | yes |
| `exec_trust.json` approvals, keyed `"<kind>:<dir>"` (`exec_trust.rs:147`) | **no**: the user is asked again | **no** |
| box folder, member links, box-links doc block (absolute roots, `boxes.rs:255-275,341`) | **no**: stale until `refresh_box_agent_docs` (`boxes.rs:785`) | **no** |
| archive restore manifests | **no** | **no** |
| other entries pointing into the folder | refused (`nested`, `:1538`) | no check |
| agent histories (below) | **no** | **no** |
| VM, remote, symlinked folders | refused (`:1498`) | remote only |

`rewrite_path_prefix` rewrites whole string values only: not JSON keys, and
not a path inside a longer string such as a saved `cd …/x && make`.

Already path-free: session dirs, agent homes and scheduled prompts are keyed
by project id (`agent_home.rs:51`). `live_sessions/<uid>` holds ids only, and
`agent_prompts.json` / `agent_tasks.json` key by project and tab. The phone
sees only ids.

##### Agent histories: the main gap
Each scope's agents run with `$HOME` = `<state>/agent-homes/<project key>`
(`agent_home.rs:3-14`). The key is not derived from the path. Inside a home,
though, the CLIs file history by cwd:

| CLI | Filed by cwd | Resume (`stores/tabs.ts:5945`) | Without a carry |
|---|---|---|---|
| Claude | `.claude/projects/<cwd, / and . → ->/` (transcripts, `memory/`); `.claude.json` `projects["<cwd>"]`; `.claude/history.jsonl` `project` | `--resume <id>`. The app finds the id in any dir (`agent_session.rs:387`), but Claude itself looks only under the cwd's dir | resume fails, memory is gone, folder trust is asked again |
| Codex | `.codex/config.toml` `[projects."<cwd>"]`; rollout `session_meta.cwd`; `state_<n>.sqlite` threads (`codex_store.rs`) | `codex resume <id>` (`agent_session.rs:175`) | trust asked again; resume **unverified** |
| Gemini, Qwen, opencode, Copilot, cursor-agent, Grok, Droid, Antigravity | per-CLI cwd stores (**unverified**) | `--resume latest` / `--continue` | starts a fresh conversation |
| Vibe | own id, recorded by a hook (`agent_session.rs:56`) | `--resume <id>` | probably fine (**unverified**) |

`token_stats.json` keeps a cursor per home-relative file and moves a gone
file's tokens to `retired` (`token_stats.rs:10-16`). A renamed transcript
dir would therefore be counted twice unless its cursor keys move with it.

The user's own `~/.claude/projects/-home-<u>-eldrun-…` only seeds a *new*
home (`agent_home.rs:183,242`). Phase M neither needs it nor touches it.

##### The rest of the tree and its holders
- Joined with `app_home()` (`paths.rs:592-653`): `projects/`; `projects-ssh/`
  (default mirror parent, `projects.rs:99`); `root/` (the root console's cwd,
  with agent home `root`, `usage_stats.rs:244`, `agent_fence.rs:450`);
  `boxes/` (`boxes.rs:711`); `archive/` (`projects.rs:949-1342`).
- Holders of absolute paths into the tree:
  - state files: `projects.json`, `boxes.json` `folder`, `terminals.json`,
    `remote-projects/*`, archive manifests, `exec_trust.json` keys;
  - inside projects: box links and doc blocks, `project.json` (gitignored by
    default, `projects.rs:3040`, but tracked in some repos), worktree files,
    venv shebangs and `pyvenv.cfg`, cargo `target/` fingerprints;
  - agent homes (above), and the agent-global layer, which holds the user's
    imported config.
- Dev builds of this checkout name it absolutely. The binary compiles in
  `TABTIVITY_DEV_SOURCE_ROOT` (`dev_build.rs:28`, `package-dev.sh:112`). The
  Dev and HotReload `.desktop` files have `Exec=$ROOT/…` (`package-dev.sh:312`,
  `package-local.sh:62`). The freeze tree is a linked worktree at
  `$ROOT/target/freeze-tree` (`package-dev-auto.sh:93`).
- Remote, HPC and lockstep peers never get the local path. Lockstep moves
  bundles of objects and refs only (`git_peer.rs:1-20`). Byte-sync manifests
  are local, and remote agents keep their history on the host.
- Other machines can point *into* this tree. A project whose SSH host is this
  machine stores `remote_path = /home/<u>/eldrun/projects/x` over there.
  Nothing local can see or fix that; the link below keeps it working.
- Project transfer (`docs/context/project_transfer.md`) re-points paths on
  import but does not carry agent histories either.

#### Design

##### One rename of the tree, not one move per project
Moving projects one by one splits the tree. The first move creates
`~/tabtivity`, and `app_home` flips at once. `root/`, `boxes/` and
`archive/` then resolve to empty folders, archived projects vanish from
Settings, and the root console opens in an empty folder until the last
project has moved.

So Phase M makes one atomic `rename(2)` of `~/eldrun` to `~/tabtivity` (same
parent), leaves a link at `~/eldrun`, and then runs the move flow's re-point
half for every holder. It is not a bare `mv`: every holder is rewritten in
the same resumable migration. The migrator already does this for the state
dir: `move_dir` (`brand_migration/state_dir.rs:160`) handles a crash before
the link, an empty placeholder, both names present, and the phone host.

##### When: at the next start, before anything opens
The button only writes a request, `<state>/home-move.json`. The move runs as
launch steps in `run_at_launch` (`host.rs:163`, `lib.rs:1043`). They run
before the webview, the registry readers, watchers, tmux and containers, so
nothing holds a path. Doing it in a live window would mean closing every
project and the root console and patching every store. The new steps go
after `agent-homes` in `STARTUP_STEPS` (`mod.rs:243`). Each one returns
`NothingToDo` when there is no request.

1. `home-gate` stays pending, with a reason, when:
   - an env override is set;
   - a live window answers on `desktop-control.sock`;
   - `~/tabtivity` exists and is not an empty folder;
   - `~/eldrun` is a mount point.

   It then stops the phone host (`World::stop_host_in`), which could fire a
   scheduled prompt into a project. The normal launch restarts the host.
2. `home-tree`: `move_dir(env, "home-tree", ~/eldrun, ~/tabtivity, false)`.
   The link is made right after the rename, so holders not yet rewritten
   still resolve. A failed rename (Windows lock, EXDEV) changes nothing and
   stays pending, and the app keeps running from `~/eldrun`.
3. `home-paths` rewrites `~/eldrun` → `~/tabtivity` in:
   - `state_json_files` (`state_dir.rs:326`), via `rewrite_json_locked`;
   - archive manifests (`state_dir.rs:341`);
   - `exec_trust.json` keys;
   - each moved `project.json` and each box doc block.
4. `home-git` runs `git worktree repair` with the moved worktree paths
   (`moved_linked_worktrees`). It covers every registered repo that moved,
   plus every repo outside the tree with a worktree inside it. It uses
   `hookless_git_command_in` and reads only `.git/worktrees/*/gitdir`. It
   never walks a project folder, because those are attacker-controlled.
5. `home-agents`: the history carry, below, for every home and the layer.
6. `home-done` deletes the request. `home-tree` is no longer counted, since
   `resolve_named_dir` now finds `~/tabtivity`.

Every step is idempotent: a prefix that is already rewritten no longer
matches. A crash leaves `started` in `migrations.json`, and the next launch
resumes before anything reads state. Before step 2 nothing has changed.
After it, the link keeps the install working.

##### History carry (`home-agents`)
All writes go through `services::home_io`, because homes are agent-writable.
For each home's `.claude/projects/*`:
- Take the real cwd from the transcripts (`transcript_cwd`,
  `sandbox.rs:1575`), not from the lossy name. If it is under the old tree,
  rename the dir to Claude's encoding of the new cwd.
- If that target exists (a partial run, or a tab started since), move the
  files in without overwriting anything, `memory/` included. Session ids are
  unique, so nothing collides.
- In the same pass, rewrite the matching `token_stats.json` cursor keys.

Rewrite path keys and values in `.claude.json`, `.claude/history.jsonl` and
`.codex/config.toml` with the text-level `replace_path_prefix`
(`agent_homes.rs:162`). It handles JSON escaping and component boundaries.

Other CLIs get only what M0 proves needed and safe. Codex's SQLite store is
never written without a backup and a read-back. A CLI with no safe carry
loses "continue last" once, and the preview says so. The same carry is wired
into `rename_project_dir` and `move_remote_mirror`, so a one-folder rename
stops losing history too.

##### The button and the dialog
- **Where:** Settings → Updates → "Names from before the rename"
  (`LegacyNamesSummary.tsx`, `UpdatesPanel.tsx:278`), on the `home-tree` row.
  It is shown only while that hit counts and no override is set.
- **Dry run:** the dialog uses the shared scheme with an explicit `color`.
  It shows `home_move_plan`, which writes nothing:
  - the two paths and the gate's blockers;
  - every project under the tree (local, mirror, box, root, archived) with
    what changes: registry, `project.json` ("tracked in git" flagged),
    tabs, worktrees, container recreate, approvals, and per CLI the history
    dirs found and whether they will resume;
  - VM projects and projects outside the tree, listed as unchanged.
- **Warnings:**
  - venvs keep absolute shebangs and work through the link;
  - cargo `target/` rebuilds;
  - this checkout's dev launchers are affected (see "This checkout");
  - other machines may point here;
  - the user's own `~/.claude` is left alone.
- **Consent:** a checkbox ("terminals and editors outside the app are closed
  in these folders"), then "Move at next start" or "Quit and move now". The
  second quits cleanly; the user starts the app again. A pending request can
  be cancelled until then.
- **Progress and failure:** the move takes seconds, so there is no progress
  bar. After the start the same panel shows done, or pending with the step
  and the reason, plus "Try again at next start". The app is usable in every
  state.
- **Strings and pill:** all strings via `useT()` under `updates.homeMove.*`,
  with every dictionary filled. The button and the dialog carry
  `<UntestedTag id="updates.homeMove" />`, with a row in `src/lib/untested.ts`.

##### This checkout
`~/eldrun/projects/projecteldrun` moves with the tree.
- At launch nothing of the app runs in it.
- The running dev binary and the `.desktop` launchers name the old path and
  work through the link.
- The next commit's post-commit build compiles in the new root and rewrites
  the Dev `.desktop` (`package-dev.sh:312`).
- `home-git` repairs the freeze tree and `.claude/worktrees`.
- The first cargo build afterwards is a full rebuild.
- Outside processes keep their cwd inode.

Recommendation: include it, and run Phase M right after a commit with
outside terminals closed. Re-run `package-local.sh` (HotReload entry) before
release B removes the link.

#### Implementation phases (one subagent each)
- **M0 Probe the CLIs (no product code).** Work in a copy of an agent home,
  running each CLI with `env -u TABTIVITY_TAB_UID`. For each CLI: create a
  session in `/tmp/a`, rename the folder to `/tmp/b`, carry the store, then
  test `--resume`/`--continue` and memory. Find the stores by grepping for
  the literal path, Claude's encoding, and sha256/md5 of the path.
  - Output: the tables above, completed; the minimal carry per CLI; fixtures
    in `src-tauri/test-fixtures/home_move/`.
- **M1 Re-point core.** Move the second half of `rename_project_dir` into
  `services::relocate` (AppHandle-free). It covers the registry,
  `project.json`, `terminals.json`, `exec_trust` keys, the box refresh, and
  worktree repair through `hookless_git_command_in`. Both folder movers call
  it.
  - Tests: every holder is rewritten; `/p/foobar` is left alone; nested
    worktrees are repaired; a rerun is a no-op.
  - Also survey `localStorage` for absolute-path values.
- **M2 History carry.** `services::agent_history_move`: the Claude dir
  rename and merge, `.claude.json`, `history.jsonl`, Codex trust, the
  `token_stats` keys, and the M0 carries. All through `home_io`, wired into
  M1.
  - Tests: a lossy name (`a-b` vs `a/b`); a merge into an existing dir; a
    planted symlink is not followed; token totals are unchanged after a
    rescan.
- **M3 Launch steps.** `home-move.json`, `home-gate` … `home-done`, and
  `World` methods for the live-window probe and the host stop.
  - Tests with the migrator harness (`brand_migration/testing.rs`,
    `crash_at`/`fail_at`): a crash at every checkpoint resumes to the same
    end state; with no request nothing happens; a non-empty `~/tabtivity`
    stays pending; a fresh install does nothing; afterwards
    `resolve_named_dir` finds the new path with no hit.
- **M4 Command and UI.** `home_move_plan`, `home_move_request` and
  `home_move_cancel`, with camelCase payloads. The dialog, i18n, the
  untested row, and file-map rows. A boot rewrite beside
  `brandMigrationBoot.ts`, if M1 found `localStorage` paths.
  - Vitest: the preview, consent gating, cancel, a pending result.
- **M5 Copy run and docs.** Add `--home-move` to `scripts/brand-copy-run.sh`
  / `copy_run.rs`. It copies the tree, state dir and homes into a scratch
  home, runs the steps, and lists the leftover holders of the old prefix,
  literal and Claude-encoded (`holders_of`). Then update
  `docs/context/brand_migration.md` and the help docs.

Each phase runs the six `AGENTS.md` gates and `npm run backend:stale`.

#### Verification
- Unit tests per phase, as listed.
- Copy run (M5) on a copy of this machine's real `~/eldrun` and state dir.
  It passes when:
  - nothing holds the old prefix except prose inside transcripts;
  - every registered dir exists;
  - `git worktree list` is clean in every repo;
  - every Claude and Codex session id is found under its new cwd.
- Live, on the frozen dev build, clicked through by the user:
  1. Settings → Updates: the `home-tree` row has the button. Check the
     preview's projects and warnings, then cancel.
  2. Request the move, quit, and start the app. The panel says done,
     `home-tree` is gone, and `~/eldrun` links to `~/tabtivity`.
  3. Open this project. The tabs restore in `~/tabtivity/…`, a Claude tab
     resumes with its memory, and a Codex tab resumes.
  4. A worktree agent tab works.
  5. A container project starts, a box's member links work, an archived
     project restores, and the root console opens in `~/tabtivity/root`.
  6. Commit asks for no new approval, and today's token totals are
     unchanged.
  7. A new project lands in `~/tabtivity/projects`.

#### Open decisions for the user
1. **One tree rename or a move per project?** Recommend the single rename
   plus re-pointing every holder. This replaces the old "each project through
   the move flow" rule, because per-project moves split the tree.
2. **Leave a link at `~/eldrun`?** Recommend yes, until release B removes it
   after a holder scan, as for the state dir.
3. **Next start or the running window?** Recommend next start.
4. **This checkout?** Recommend moving it with the tree. Excluding it needs
   a separate move.
5. **CLIs with no safe carry?** Recommend one fresh start per tab, with a
   preview warning, rather than blocking Phase M.
6. **Codex rollout `cwd` / SQLite rewrite?** Only if M0 shows that resume
   fails without it, and then with a backup.
7. **Exec approvals?** Recommend carrying the keys. The content fingerprint
   still guards them.
8. **A tracked `project.json`?** Recommend rewriting it, with a warning.
9. **The user's own `~/.claude` dirs?** Leave them alone and list them as
   untouched.

#### Unverified assumptions
- Claude `--resume <id>` looks only under the cwd's encoded dir.
- Codex `resume <id>` from a new cwd works.
- How each other CLI files history by cwd (M0).
- `desktop-control.sock` tells a live window from a stale socket.
- `git worktree repair` fixes both sides when the repo and its worktrees
  moved together.
- No `localStorage` value holds an absolute project path that matters.
- On Windows the `%USERPROFILE%\eldrun` junction serves every holder, and a
  locked rename fails cleanly. macOS is untested.
- Nothing synced holds this tree's path, except other machines'
  `remote_path`.

### Phase 5: release B — the cleanup
- Gate: `legacy-hits.json` empty on every machine for a few weeks, no mail
  store on old labels, Phase M done everywhere (or the `~/eldrun` branch
  kept), the state-dir scan and the `~/eldrun` link scan clean.
- Delete the `LEGACY_*` constants except the migrator's, fix what fails to
  compile, remove the dual reads, the fallback log, the shim alias, the dev
  stubs, the old env exports and the state-dir symlink. Delete the mail-store
  backups and the old webview data dir.
- `brand-check.sh` allowlist shrinks to the migrator, the import of old
  bundles, and history prose.

## Verification
- After each phase run:
  - the five gates from `AGENTS.md` (`npm run build`, `npm test`,
    `cargo test`, `npm run lint`, `cargo clippy -D warnings`)
  - `git diff --check`
  - `scripts/privacy-check.sh`
  - `scripts/brand-check.sh`
  - `npm run backend:stale`
- Phase 0:
  - a vitest renders `t()` for every key containing `{app}` in all 5
    languages, with and without params
  - a unit test feeds `is_repo_download_url` URLs from the old repo, a renamed
    repo, and a foreign host
- Phase 1: the UI renders identically, and `brand-check.sh` is clean.
- Phase 2, with a test brand and a temp `ELDRUN_STATE_DIR`/`ELDRUN_HOME`:
  - **fresh-install test:** start from an empty temp home, run first launch,
    then search the whole temp tree, keyring namespace and written configs for
    "eldrun". It must find nothing.
  - **upgrade test:** seed old-shaped state, run the migrator, and check that
    each table row moved, nothing was lost, and a second run changes nothing
  - **crash test:** kill the migrator mid-step; the next run finishes cleanly
  - a mail store written with the old labels decrypts after re-encryption,
    every record, and the backup still decrypts too
  - an agent home seeded before the change is not seeded again
  - old hook entries are replaced, not duplicated
  - old tmux names attach; old Docker labels are swept
  - a worktree under `.eldrun/` still works after the folder rename
  - both env names are exported
  - every dual read logs a hit
- Release A, live, by the user (agents never start the app). Upgrade an
  existing install with a packaged build and check:
  - no second copy appears in the app menu, the deb list or Windows Apps
  - projects, tabs, UI settings and agent sessions restore
  - remote tmux reattaches
  - the mobile host restarts under its new name and the phone stays paired
  - mail opens and decrypts after the next unlock
  - `eldrun-send` and `tabtivity-send` both work in a fenced tab
  - `npm run backend:stale` and the post-commit frozen build still find the
    binary
  - the updater finds a release after a test repo rename
- Release B: the five gates, `brand-check.sh` with the short allowlist, and the
  fresh-install test again.
- Expected at release A, not bugs:
  - After a deb upgrade while the app runs, `/usr/bin/eldrun` is gone and the
    agent shims still point at it, so fenced CLIs fail until the app restarts.
    Say so in the release notes.
  - An installed PWA on iOS keeps the home-screen label "Eldrun Mobile" until
    it is re-added. Pairing is unaffected.
  - A pinned dock or taskbar launcher for the old `.desktop` entry is lost.
  - Projects with their own MCP allow rules ask once for permission again.

## Unverified (check before the step that needs it)
- Tauri's NSIS keying of the uninstall entry and install dir on `productName`.
- Tauri 2 `mainBinaryName`.
- Webview data-dir paths on Windows (WebView2) and macOS, for the copy step.
- Whether the mail store can be re-encrypted record by record, or needs a
  whole-store rewrite.
- ~~Whether the project-move flow carries agent session histories (Phase M).~~ Answered 2026-10-02: it does not; see Phase M.

## History

### Third revision (2026-10-01): full replacement
- The two reviews below kept ~25 names old forever to avoid migrations. The
  user wants "Eldrun" gone everywhere, with fresh installs using only
  Tabtivity. The Keep table became the migration table; each row got a
  release-A step and a release-B cleanup.
- New: the migrator module, the fallback log, the state-dir symlink, release B
  as its own phase, the optional `~/eldrun` move (Phase M), the fresh-install
  and crash tests.
- Corrected along the way: the phone does not need re-pairing, because the new
  PWA copies its IndexedDB on the same origin. The Docker image is re-tagged,
  not rebuilt.

### Second review (2026-10-01)
A second review checked the plan against the code. The claims it spot-checked
held (hit counts, `pick_asset`, the `translate()` early return, no `{app}`
param, `is_eldrun_hook`). It added the mail key labels (data-loss risk), the
mobile-files HKDF salt, the agent-home markers, the VM guest user and
instance id, the `eldrun.spec` label, the worker bundle and the `info/exclude`
line; the hardcoded binary paths in the dev scripts and `dev_build.rs`; the
CI dmg and artifact names; the 132 frontend test files; user agents; the
macOS side-by-side bundle; the privacy-denylist entry; the expected effects at
the flip; the updater-bridge owner decision. It moved the MCP names and the
box-links marker to Keep — the third revision migrates them instead, accepting
a one-time re-prompt for project-level allow rules and requiring synced
machines to update together.

### First review (2026-10-01)
It stopped the draft from moving the state dir without a plan for the paths
that hold it (remote projects, agent hooks, the mobile host's unit, Windows
locks) — the third revision moves it with those rewrites and a symlink. It
added the serde keys, saved tab commands, timer id, PWA IndexedDB, WebSocket
subprotocol, Docker labels, Ollama drop-ins, box/global backup files, export
manifest, launchd label and Windows Run value; deb/NSIS side-by-side installs;
`bump-version.sh` as a flip point; the i18n no-params path; hardcoded mobile
strings; the VAPID subject and the dev-script stubs.

Side finding (not part of this plan): `AGENTS.md` still says agent logins are
"hard-linked" into every home; since 2026-09-26 they are copies
(`agent_auth.rs:7,19`).
