# Structure budget — plan

Status: plan only (2026-10-26), reviewed by two plan reviewers the same day.
No code changed. Builds on `docs/code_screen_plan.md` section S, which owns
the file splits (another session runs S5 and S7 first, 2026-10-26; see
"Sequencing with code screen S5/S7"); this plan adds the guard that keeps the result from
regrowing, a boundary for the optional features, and the process rules
around them. U1–U3 decided 2026-10-26 (see "User decisions"); U4 is
approved at step 5. Step 3 now only picks stub vs gate per add-on.

## Why

The tree is ~870k lines (desktop TS 490k, Rust 340k, phone 37k) written in five
months, mostly by agents, with one human maintainer. 99 non-test source files
are over 1,500 lines (113k lines over that limit); the largest are `src/components/embed/FileViewerPane.tsx`
(10,870), `src-tauri/src/services/mobile_control/host.rs` (7,942),
`src/stores/tabs.ts` (6,888), `src-tauri/src/commands/mail.rs` (5,760),
`src/components/embed/pdf/PdfViewer.tsx` (5,526). Agents grow big files
fastest, because a big file is where the code they need already is. Two goals:

1. **Maintainability:** every file small enough to read whole; a split that
   lands stays split.
2. **Scope:** the three pillars (project desktop, remote/HPC, phone) are the
   core; the workspace apps around them are add-ons that can be frozen or
   compiled out without touching the core.

## Fixed decisions

1. **The size budget counts lines of non-test source.** `.ts`, `.tsx`, `.rs`
   (and `.mjs` under `scripts/`) that are tracked or untracked-not-ignored.
   Excluded: any `__tests__/` dir (`src/__tests__/` holds the phone's tests
   too; `mobile-web/` has none), `*.test.*`, sibling `tests.rs` (34 today,
   most from code screen S1) and crate `tests/` dirs (`src-tauri/tests/`),
   `src/lib/i18n/{en,de,es,fr,it}.ts` (dictionaries), generated files —
   first line starts `// Generated from` (`src/lib/transport/commandClasses.ts`,
   `src/lib/agents/agentCliTable.ts`) — and `src-tauri/patches/` (the vendored
   `tauri-runtime-wry`). There is no `vendor/`. An inline
   `#[cfg(test)] mod tests { … }` still counts: 24 of the oversize Rust files
   are over only because of one. That keeps code screen S1's direction
   (tests in a sibling `tests.rs`); the gate's failure message names the
   move when the file is over only by its test module, and cutting tests is
   never the fix (one line in the AGENTS.md Gates entry, step 1).
2. **New files: at most 1,500 lines** (U3, decided).
3. **Existing oversize files ratchet.** `scripts/size-budget-baseline.json`
   maps each oversize path to its current line count. A listed file may not
   exceed its number. `--update` only lowers numbers and drops entries that
   fell under the limit; raising one is a hand edit, visible in the diff, and
   needs a reason in the commit message. A file moved by an S step takes its
   entry along in the same commit.
4. **One node script, no dependency.** `scripts/size-budget.mjs`, not ESLint
   `max-lines` (ESLint never sees the Rust half, and ~100 per-file overrides
   would swamp `eslint.config.js`) and not clippy `too_many_lines` (pedantic,
   hundreds of hits today). Function length is not gated in this plan.
5. **Add-ons reuse what exists.** Runtime switch: the existing
   `useExperimental` flags (`src/lib/experimental.ts`) and the plain settings
   toggles that already gate an add-on (`todo_board`, `daily_stats_recap`, …).
   Build switch: Cargo features in `src-tauri/Cargo.toml` on the `voice`
   precedent — **on by default**, so every package and the frozen dev build
   stay as they are. (`default` does not reach the daemon: `src-serverd`
   takes the library with `default-features = false`, so it names the
   add-ons it serves itself — step 4.) No new add-on framework, no
   per-add-on frontend bundle.
6. **Nothing is deleted by this plan.** Freezing or removing an add-on is the
   user's call (U2, decided: four frozen, none removed). Frozen = bug and
   security fixes only.
7. **The backlog is moved, never deleted.** Stale items go to
   `todo/someday.md`; 🖐️ manual boxes and their platform children stay where
   they are.
8. **Dead-code tools are advisory.** They report; deletions follow the code
   screen's E rule (re-check with `rg`, delete together with their tests).
9. Hot shared files (`AGENTS.md`, the filemaps, `src/lib/untested.ts`,
   `services::command_class` + `commandClasses.ts`, `src/lib/i18n/`,
   `src-tauri/Cargo.toml` `[features]`, `lib.rs`'s `generate_handler!`) are
   edited by one step at a time; parallel implementers list their edits in
   the handoff and the main agent applies them at merge.

## User decisions (2026-10-26)

- **U1 Core — decided:** project desktop + boxes, agents and terminals,
  files/viewers/editors (incl. PDF and LaTeX), Git, remote/HPC/sync, phone
  app, the fence. Never frozen, never compiled out. Everything else is an
  add-on.
- **U2 Add-on fate — decided:**

  | Add-on | Frozen (fixes only) | Own Cargo feature (step 4, default on) |
  |---|---|---|
  | Print manager | yes | yes |
  | Deck presenter | yes | yes |
  | Daily recap | yes | — (frontend only) |
  | Web browser | yes | — |
  | Mail (+ mail AI, OpenPGP) | no, active | yes |
  | Calendar/CalDAV + to-do board | no, active | yes, **one** feature (shared store) |
  | Tabby assistant, Copilot completion | no, active (not asked: default) | — |
  | Voice | no, active | already has `voice` |

  Nothing is removed. Freezing the web browser also freezes what Tabby's
  web lane can gain through `browser_engine::fetch_for_agent`; a fix there
  is still allowed. Step 4 covers print manager, deck presenter,
  calendar + to-do and mail, in that order.
  Couplings this respects: calendar and to-do share one store
  (`calendar_load`/`_save` carry both; `services::server::features_of`) —
  one feature, or to-do requires calendar; Tabby's web lane fetches through
  the browser's `browser_engine::fetch_for_agent` and sanitises with mail's
  `mail_sanitize`; voice already has its feature; mail, calendar and to-do
  are also served by the daemon and already have a runtime switch there
  (gateway `policy.json` `features`, the user's `disabled_features`).
- **U3 Limit — decided:** 1,500 lines.
- **U4 Wording** of the two AGENTS.md rules in step 5 — still open; the
  step-5 implementer drafts it and the user approves before it lands.

## Steps

### Step 1 — Size budget gate

New `scripts/size-budget.mjs`:

- File list: `git ls-files -co --exclude-standard` (the `-o` half is what
  `scripts/lib/changed.sh` adds for untracked files), filtered by decision 1;
  skips paths missing from the worktree (`-c` still lists a tracked file
  deleted but not staged) and non-regular files. Counts newline-terminated
  lines (`wc -l` semantics). Whole tree every run (~2,400 files, well under a
  second), so it is right under `--base` too.
- `--root <dir>`: run against another checkout (the tests' temp repos).
- Default mode: exit 1 listing every file over its budget
  (`path  lines / budget  (+n)`), else print one line
  (`size budget: ok, N files on the baseline, M lines over the limit`). An
  entry that is now lower than its number, under the limit or gone is noted
  (`K entries can tighten: --update`), never a failure.
- `--update [<path>…]`: rewrite the baseline, lowering numbers only and
  dropping files now under the limit or gone; refuses to raise a number.
  With paths, touches only those entries — the form a commit uses, because
  the worktree holds other sessions' uncommitted edits: a whole-tree
  `--update` can record a shrink that is not in the commit, and CI then fails
  that commit's file against its own baseline.
- `--report`: the 20 files furthest over the limit, then every Rust file
  over only because of an inline `mod tests { … }` (S1-style move), and the
  total lines over it — the number the S steps drive down.
- Spells no brand name: `scripts/brand-check.sh` fails on either name in
  `.mjs` code or strings (a comment may name the current one), and on the
  baseline JSON, which is plain paths. `scripts/lib/brand.sh` is not needed.

New `scripts/size-budget-baseline.json`: `--init`, refused once the file
exists, writes it from the current tree (99 entries on 2026-10-26, 113k lines
over the limit; 153 files would have been over 1,000). After that only
`--update` and hand edits change it.

Wire it in:

- `scripts/gates.sh`: `gate size 1 node scripts/size-budget.mjs` after
  `gate brand`; add `size  always  node scripts/size-budget.mjs` to the
  `--list` heredoc and the size budget to the header comment's `always` line.
- `.github/workflows/ci-cd.yml`: the `brand` job is checkout-only (no Node
  step), so add the step to the `lint` job after "ci-local.sh mirrors this
  workflow", where the pinned Node is set up.
- `scripts/ci-local.sh`: a `STEPS` row `size|lint|<exact step name>|ci|always`
  next to `drift`. `ci-local.sh --check-drift` (run by that same lint job)
  fails on a ci-cd.yml Linux step that has no `STEPS`/`ALLOW` row, so CI
  enforces the mirror.
- `AGENTS.md` Gates block: one line,
  `scripts/size-budget.mjs   # files ≤ 1,500 lines; oversize ones only shrink`,
  plus "over the budget: split the file or move its inline tests to a
  sibling `tests.rs`, never delete tests".
- Filemap: a row after `../../scripts/gates.sh` in `docs/filemap_backend.md`
  (the scripts' rows live there; `brand-check` has none).

Tests: vitest, like `src/__tests__/shell/UntestedRegistry.test.ts`
(`spawnSync("node", ["scripts/…mjs", …])`), with throwaway repos built by
`mkdtempSync` + `git init` as in `src/__tests__/git/PrePushPreflight.test.ts`;
`scripts/test_*.py` are Python-only and run outside the gates. Cases: new file
over the limit fails; a baseline file that grew fails; `--update` lowers and
drops, never raises; `--update <path>` leaves other entries; `--init` refuses
an existing baseline; excluded paths and a deleted tracked file are ignored.
A later change to the script alone selects no vitest in gates.sh
(`changed.sh` counts `scripts/` as non-frontend), so run the file by hand:
`npx vitest run src/__tests__/shell/SizeBudget.test.ts`.

### Step 2 — Burn-down order (extends code screen S7)

Runs after S5 and S7 have landed (another session runs them first). The
S7b list goes into `docs/code_screen_plan.md` only then, so this plan never
edits that file while the other session works from it.
Rank the baseline by lines over the limit. Code screen S7 covers
`FileViewerPane.tsx`, `SettingsSubPanels.tsx`, `stores/tabs.ts`, `FileTree()`,
mobile `Terminal.tsx`, `git_peer.rs`'s apply loops and three long functions
(`launch_prep.rs` `prepare`, `pty_bridge.rs` `attach`, `sync_auto.rs`
`reconcile_pass`); S5 thins `commands/{projects,ollama,git,mail,fs}.rs` (and
moves only `agent_bins` out of `commands/agents.rs`).

First, cheapest: the 24 Rust files over only because of an inline
`mod tests { … }` (`--report` lists them) get S1's move to a sibling
`tests.rs` — mechanical, check `include_str!` source-scan tests first. Then
an **S7b** list in `docs/code_screen_plan.md` for the top 15 that neither S5
nor S7 covers (2026-10-26; `*` = has an inline test module to move first):
`services/mobile_control/host.rs` 7,942 · `embed/pdf/PdfViewer.tsx` 5,526 ·
`terminal/mod.rs` 4,302 · `services/mail/mail_store.rs` 4,100 ·
`lib/viewers/tex/tex.ts` 3,951 · `services/root_mcp.rs` 3,789 ·
`sysstat.rs`\* 3,621 · `mobile/MobileBridgeHost.tsx` 3,174 ·
`commands/project_transfer.rs`\* 3,091 · `commands/agents.rs`\* 3,088 ·
`services/agent/agent_session.rs` 3,041 · `commands/apps.rs`\* 3,011 ·
`files/ProjectFilesView.tsx` 2,906 · `services/openvpn.rs` 2,893 ·
`services/sandbox.rs` 2,864. (`src-tauri/src/lib.rs`\*, 2,928, is left
out: ~850 of its lines are the one `generate_handler!` list, which cannot
be split.) An add-on's file (`mail_store.rs`) waits
until step 4's mail gating (4m2) has landed, so the two do not fight.
One file per commit, each running `--update <old> <new…>` so the baseline
shrinks with the split; a moved file takes its entry along (decision 3).
Code screen rules: quiet tree, the user's go-ahead per S step, `git mv` of
the original to the part that keeps most of it, for blame.

### Step 3 — Add-on inventory (read-only)

For each step-4 add-on (print manager, deck presenter, calendar + to-do,
mail), one row in the appendix (a head start is there):

| Add-on | Runtime gate | Entry points (desktop / phone / MCP) | Rust modules + commands (class) | Core → add-on calls | Crates only it pulls in | Lines (TS / Rust) | Daemon? |

Sources: `src/lib/experimental.ts`, `src-tauri/src/schema/settings.rs`, the
filemaps, `services::command_class`, `services::server::features_of`,
`commands/mod.rs` (which modules are already `desktop`-only),
`mobile_control/host.rs`'s `/api/v1/*` routes, the root MCP tool families
(`root_mcp_security.rs`). "Crates only it pulls in": `cargo tree -i` shows
reverse edges only; compute the set difference from `cargo metadata
--offline` (crates reachable from all direct deps minus those reachable
without the add-on's). "Core → add-on calls": code outside the add-on that
calls into it — each is cut (moved to a shared module) before the add-on
can be gated. Ends with the pattern per add-on (stub or gate, step 4),
recorded in the appendix; no user question (U2 is decided).

### Step 4 — Add-on Cargo features (one add-on per commit)

What exists (verified 2026-10-26): `voice` does **not** cfg its commands
out. They stay registered; `services::voice::{stt,capture}::BUILT =
cfg!(feature)` swaps in a stub that answers `VoiceError::NotBuilt`, and
`voice_status().listen` tells the frontend. `commands/{presenter,printing,
print_native,voice}` are already `#[cfg(feature = "desktop")]` in
`commands/mod.rs`, so they are not in the daemon. Two patterns, picked per
add-on in step 3:

- **Stub** (the voice way): commands stay; their bodies answer a named
  "not built" error; only the optional deps and the code using them go.
  Nothing in `lib.rs`, `build.rs`, `command_class` or `commandClasses.ts`
  changes. For small command surfaces.
- **Gate**: the module and its commands go. Constraints of today's code:
  - `build.rs` (the core dispatcher) copies to the wrappers only a
    *single-line* `#[cfg(…)]` directly above `pub mod x;` in
    `commands/mod.rs` (a second stacked `#[cfg]` overwrites the first; any
    other attribute in between drops it) and `#[cfg]`s on the command fn
    itself; an inner `#![cfg]` in the file is invisible to it. A
    desktop-only add-on's feature therefore implies `desktop`
    (`print-manager = ["desktop"]`) so one `#[cfg(feature = "…")]` line
    suffices.
  - `generate_handler!` (tauri-macros 2.7.2) accepts `#[cfg(feature =
    "…")]` per entry, but `command_class::tests::registered_commands()`
    asserts every comma-split token starts with `commands::` — teach it
    to strip a leading `#[cfg(…)]` (one feature, no comma inside: it
    splits on commas).
  - `command_class::TABLE` rows stay unconditional, so
    `commandClasses.ts` is identical in every build and its test stays
    green in all of them. `services::server::feature_on` answers false for
    a feature not compiled in (`Feature` already has Mail, Calendar,
    Todo), so `server_capabilities` reports `FeatureOff` rather than
    "no wrapper was generated".

Step 4.0, once, before the first add-on (its own commit):

- the `registered_commands()` parser change and the `feature_on` check
  above;
- one Tauri-free command `built_addons` (class `core`, so the browser
  client gets it too; row + regenerated `commandClasses.ts`), read once
  at boot and cached in `src/lib/experimental.ts` the way
  `lib/shortcuts/superKey.ts` caches `desktop_owns_super_key` — the
  desktop window has no general payload for it (`app_build_commit` is a
  bare string, `workspace_capabilities` the window backend's,
  `server_capabilities` browser-only). Not loaded yet = built, so the
  default build never flickers or withdraws anything;
- an all-off gate: `cargo clippy -p tabtivity --no-default-features
  --features desktop --all-targets -- -D warnings` in `scripts/gates.sh`
  (src-tauri group), `ci-cd.yml` and `ci-local.sh`, plus its `AGENTS.md`
  Gates line (zero warnings: helpers only an add-on used get gated with it).

Per add-on:

- `src-tauri/Cargo.toml`: `<addon> = [<its optional deps>]`, in `default`.
  No add-on lives in `app-core` today (its `web_safety` is shared by mail
  and the browser and stays), so no `src-core` feature.
- Cut the "core → add-on calls" from step 3 first, in their own commit
  (mail: `mail_engine::install_crypto_provider` has ~20 callers outside
  mail; `browser_engine` and the web lane call
  `mail_sanitize::sanitize_message_html`).
- Code that migrates, exports, imports or re-keys an add-on's state stays
  compiled in every build: `brand_migration`, `project_transfer`, and the
  vault rotation's `mail_crypt` key-file calls — a mail-off daemon that
  rotates the vault without re-keying `<state_dir>/mail` loses the mail
  store. Never cfg a `schema/` field or type: `Settings` round-trips
  through `extra`, but a typed field moved there is invisible to its
  readers (`the_browser_settings_are_real_fields_and_not_extra_passengers`).
- Every surface hides it: desktop entry points (`experimentalEnabled` for
  the experimental ones — `mail_client`, `deck_presenter`, `web_browser`,
  `copilot_completion`, `assistant`; the readers of `todo_board`,
  `calendar_global_app`, `daily_stats_recap`; the `print_manager` tab
  kind in `stores/tabs.ts`), the phone (`GET /api/v1/status`, the
  `/api/v1/{mail,calendar,todo}` routes answering a named
  `mobile.failure.*`, screens `Mail`/`Calendar`/`Todo`/`TabbyOpen`), and
  the root MCP tool families (`root_mcp_security.rs`: mail, calendar,
  board). A compiled-out tab kind is skipped on restore but not put
  through the withdrawal sweep, which drops it at the next layout write.
- Daemon: an add-on it serves (mail, calendar, to-do) goes into
  `src-serverd/Cargo.toml`'s `features = [...]`, and the
  `--no-default-features --lib` gates (`gates.sh` `clippy-dlib`/`test-dlib`,
  `ci-cd.yml`) get the same `--features`, or they check a build the daemon
  never runs.
- `scripts/ci-local.sh` `CROSS_FEATURES` (`--no-default-features --features
  desktop,voice-io`) gets the new feature, or the Windows/macOS
  cross-checks silently drop it.
- Order: the print manager or the deck presenter first (desktop-only, no
  phone, no crates of their own: proves the cfg pattern); then
  calendar + to-do (3 crates: `psl`, `psl-types`, `roxmltree`; phone and
  daemon); mail last (~63 crates of its own, most reverse edges, touches
  `mobile_control/host.rs`). Sequential: every add-on edits `Cargo.toml`,
  `lib.rs` and `command_class.rs`.

### Step 5 — Freeze rule and backlog triage

- `AGENTS.md` Conventions, wording per U4: (a) *Frozen add-ons (print
  manager, deck presenter, daily recap, web browser): bug
  and security fixes only; a new feature there needs the user's say-so.*
  (b) *A new feature in an active area lands with, or after, a fix or a
  verified item in the same area.*
- Backlog: the unit is an *entry* — a numbered item (`15. **Title.** …`,
  the backlog's main form) with its indented lines and child bullets, or a
  top-level `- [ ]` task. An entry is stale when its *newest* line is over 60
  days old by `author-time` from `git blame --line-porcelain -w
  --ignore-rev e85e04d9 --ignore-rev cd371114` — those two rewrote ~1,350
  todo lines and added ~4,300 in bulk (the per-platform 🖐️ pairs, 2026-09-21; the rename's
  prose pass, 2026-10-01) and would make every touched entry look fresh;
  re-check `git log --shortstat -- todo/` for newer bulk commits first.
  Blame cannot see an entry moved between group files (it looks new): such
  entries stay, which errs safe. An entry that holds an open 🖐️ box stays
  whole (never split from its platform children); `scripts/parse-qa.mjs`
  reads only `group-*.md`, so a moved one would vanish from the QA Runner.
  Stale entries move to `todo/someday.md` under the same group heading,
  text and `#number` unchanged (code, docs and commits cite them). First the
  candidate list (group, number, title, last date) goes in the handoff;
  then one commit, no other edits to the files (up to 290 KB: find the range
  with `rg -n`, edit by range, never read or rewrite whole). `done.md` is
  untouched; `dev_todo` (the Todo view) lists `someday.md` after the groups
  by itself.

### Step 6 — Dead-code report (advisory)

`scripts/dead-code.sh`, printing a report and never failing. Neither tool is
in the repo or on the host today.

- `npx knip`, one root run: the phone app has no `package.json` of its own
  (one root `package.json`, phone via `tsconfig.mobile.json` +
  `vite.mobile.config.ts`). A root `knip.json` names every entry, since
  knip's Vite plugin reads only `vite.config.ts`: desktop `src/main.tsx`,
  web `src/main-web.tsx`, the phone and pdf-frame entries of
  `vite.mobile.config.ts` / `vite.pdf-frame.config.ts`, `shared/`, the
  vitest files, `scripts/*.mjs`. Pinned devDependency (lockfile churn in the
  fence: merge entries by hand, see the dep-bump notes).
- `cargo machete` at the workspace root (all four crates). `~/.cargo` is
  read-only in the fence, so the user installs it outside, like the
  toolchain; missing → reported as MISSING, never skipped silently. A dep
  used only through a macro or `build.rs` gets a
  `[package.metadata.cargo-machete] ignored` entry with a comment.
- Uncalled Tauri commands, which neither tool sees (`invoke("…")` strings):
  each `services::command_class` row with no `rg -w` hit in `src/`,
  `mobile-web/`, `shared/`, `src-gateway/`, `src-serverd/`, the MCP servers
  or `scripts/` — the check behind 59917cac.

Not a CI gate. First run's findings are verified and deleted under the E
rule in separate commits (a command goes with its registration,
`command_class` row and regenerated `commandClasses.ts`).

### Step 7 — CONTRIBUTING.md

New file at the root (none exists, `.github/` has no templates). Short,
pointing rather than repeating: build from source (README "Building from
source"), `git config core.hooksPath .githooks` once per clone, commits
under the GitHub `noreply` address (`privacy-check.sh` runs on every PR and
refuses any other author/committer email), the gates (`scripts/gates.sh`,
the size budget; `scripts/ci-local.sh` before a push), `AGENTS.md`
invariants for anyone using an agent, the brand check, `develop` as the PR
target (`main` releases), the file maps, the frozen add-ons, how to pick an
issue. The plan proposes five good-first-issue
candidates (small, one subsystem, testable without a live window); labelling
them on GitHub is the user's step.

### Later — crate extraction (not scheduled)

After code screen S5 (services no longer reach into commands) and S9
(`schema/` in `app-core`), the largest add-on (mail) can move into its own
workspace crate. Criterion: its Cargo feature from step 4 compiles cleanly on
and off for a month. Planned separately when that holds.

S5 is being run by another session; S9 is still shelved and needs the
user's go-ahead. Both are necessary, not
sufficient: mail also reaches `services::server` (vault/secrets, 17 refs),
`root_mcp`, `agent_fence`, `openvpn`, `vm_proxy`, `ai_switch` and `storage`,
which must sit in `app-core` or behind a trait first; and its commands stay
in `tabtivity` (`build.rs` reads only `src-tauri/src/commands/*.rs`, the
`command_class` test only `commands::…` paths), so the crate holds the
services alone.

## Organisation

Shape: **mixed risk**, mostly small.

- Steps 1, 5, 7: small → one implementer each, covered by the final review.
- Step 3: one read-only investigator; its table picks stub vs gate.
- Step 4: 4.0 then one implementer per add-on, sequentially, each with a
  per-step reviewer — cfg-gating can silently drop a command, desync
  `command_class`, or drop a feature from the daemon. Mail is too big for
  one agent step (≤ ~3 large files): 4m1 cut the core → mail calls; 4m2
  Rust gate (`services/mail/`, `commands/mail.rs`, `lib.rs`); 4m3 phone
  routes in `mobile_control/host.rs` + root MCP mail tools; 4m4 frontend.
- Step 2: rides code screen S, sequential, user go-ahead per file.
- Step 6: one implementer; deletions reviewed by the final review.

Bound: ≤ 5 subagents at once, ≤ 3 running cargo. Dependencies: 1 → 2;
3 → 4.0 → print manager → deck presenter → calendar + to-do → mail
(4m1–4m4); 5(a) waits for the user's U4 approval; 5(b), 6, 7 independent.
Waves against S5/S7: see the section below. 4m3 and an S7b split of
`mobile_control/host.rs` never run together; whichever lands second
rebases on the first.

### Sequencing with code screen S5/S7

Another session runs code screen S5 (services → commands inversion, thins
`commands/{projects,ollama,git,mail,fs}.rs`) and S7 (giant-file splits:
`FileViewerPane.tsx`, `SettingsSubPanels.tsx`, `stores/tabs.ts`, `FileTree`,
mobile `Terminal.tsx`, `git_peer.rs`, three long functions) first. Both move
code this plan's steps 1–4 point at, so the steps run in two waves:

- **Wave A — now, alongside S5/S7** (no file overlap with them): step 5(b)
  backlog triage (`todo/` only), step 6 (`scripts/dead-code.sh` and the
  knip config; its *first deletion run* waits for wave B, so it never
  deletes code S5/S7 is moving), step 7 (`CONTRIBUTING.md`, frozen-add-on
  list taken from "User decisions"; the size-budget line is added by step 1
  in wave B). Not in wave A: anything touching
  `src-tauri/src/commands/`, `services/`, `src/components/`, `src/stores/`,
  `mobile-web/src/`, or the filemaps (S moves rewrite their rows).
- **Wave B — after S5 and S7 have landed on develop:**
  - step 1, so `--init` records the post-split tree (fewer, smaller
    entries) and S7's own splits never have to carry baseline entries
    they do not know about;
  - step 3 against the moved code (S5 moves mail/calendar helpers into
    `services/`; the appendix paths are re-checked, not trusted);
  - step 4.0 and the add-ons (4m2 and 4m4 edit `commands/mail.rs`,
    `SettingsSubPanels`' successors and `stores/tabs/` — S5/S7's files);
  - step 2 (S7b), which extends the code screen list once S7 is done;
  - step 5(a) once the user approved the U4 wording.

The main agent checks before wave B: the code screen handoff
(`docs/code_screen_handoff.md`) lists S5 and S7 as landed, `git log`
shows their ranges on develop, and no S5/S7 worktree or uncommitted S
edit is left in the shared tree. If S5/S7 are still running when wave A is
done, wave B waits; it never runs beside them.

### Agent steps

| Agent step | Plan steps | Main files | Review |
|---|---|---|---|
| 1 | 1 | scripts/size-budget.mjs, size-budget-baseline.json, gates.sh, ci-cd.yml, ci-local.sh | final |
| 2 | 3 | read-only; appendix of this plan | main agent |
| 3 | 5 + 7 | AGENTS.md, todo/*.md, todo/someday.md, CONTRIBUTING.md | final |
| 4 | 6 | scripts/dead-code.sh, package.json | final |
| 5 | 4.0 | command_class.rs (test parser + `built_addons` row), services/server/mod.rs, experimental.ts, gates.sh, ci-cd.yml, ci-local.sh | per-step + final |
| 6…n | 4 | one add-on each (mail: 4m1–4m4): Cargo.toml, commands/mod.rs, lib.rs, its modules, its frontend gates; src-serverd/Cargo.toml if the daemon serves it | per-step + final |
| S7b | 2 | per file | code screen rules |

Five agent steps before the add-on features; step 4 adds one per add-on
(four for mail).

## Verification

- Size budget: its tests (the over-limit file lives in their temp repo —
  never a scratch file in the shared tree, where other sessions' gates
  would trip on it or commit it); `scripts/gates.sh -n` shows `run size`
  and `--list` lists it; `ci-local.sh --check-drift` and `brand-check.sh`
  pass; `--update` right after `--init` leaves the baseline byte-identical
  (`cmp` against a copy).
- Add-on features: the all-off clippy gate from step 4.0, the
  `--no-default-features --lib` gates with the daemon's `--features`, the
  command-class test,
  `scripts/gates.sh --all`; the default build behaves exactly as before.
  `npm run backend:stale` after Rust edits.
- Backlog: across `todo/*.md` (with `someday.md`), numbered entries and
  `- [ ]`/`- [x]` boxes before = after (moved, not lost); `rg -c '🖐️'
  todo/group-*.md` unchanged per file.
- Dead-code report: exits 0 with a tool missing and names it.
- Nothing here is run live; the user's click-through for step 4 is "every
  add-on still opens in the frozen dev build".

## Not done

- Deleting or disabling any feature (U2 removes nothing).
- ESLint `max-lines`, clippy `too_many_lines`, function-length gates.
- Splitting `src/styles/*.css` (`@import` order is load-bearing; code screen
  decision 5), regrouping `commands/*.rs` (`build.rs` parses the flat list).
- Per-add-on frontend bundles.

## Appendix — add-on inventory (step 3)

Head start from the plan review (2026-10-26, rough; step 3 re-checks every
cell and adds the entry-point and line columns; `?` = not checked).
Crates are Linux, of ~800 in the tree. Rough lines: mail ~26k Rust / ~12k TS,
calendar ~6k / ~6k, to-do ~4k TS, presenter 0.8k / ~11k (deck files, some
may be core viewer), print 1.5k / 2.4k, Tabby 3.8k / 0.8k, browser 3.3k /
1.2k, Copilot 2.2k Rust, voice 3.8k Rust, recap 0.8k TS.

| Add-on | Runtime gate | Rust (commands' class) | Core → add-on calls | Own crates | Daemon? |
|---|---|---|---|---|---|
| Mail (+AI, OpenPGP) | exp. `mail_client`; phone `mail_read`/`_actions`/`_reply` | `services/mail/` (15 files), `commands/mail.rs`, `root_mcp/root_mcp_mail.rs`, `schema/mail.rs`; 74 core, 1 client; phone `/api/v1/mail*` | `install_crypto_provider` (~20 callers), `mail_sanitize` (browser, web lane), `mail_crypt` (vault rotation), `mail_rekey` (phone status), VM `mail_reader` | ~63 (mail-parser/-builder/-send, async-imap, pgp + deps); argon2, ammonia shared | yes |
| Calendar/CalDAV | none; `calendar_global_app` | `commands/{caldav,calendar,shared_calendar}.rs`, `commands/calendar/`, `services/calendar/`; core; phone `/api/v1/calendar` | — | 3 (psl, psl-types, roxmltree) | yes; gateway calendar hub |
| To-do board | setting `todo_board` | `services/calendar/todo_board.rs`; shares the calendar store; phone `/api/v1/todo` | — | 0 | yes |
| Print manager | none (tab kind `print_manager`) | `commands/printing.rs`, desktop-only; client | — | 0 | no |
| Deck presenter | exp. `deck_presenter` | `commands/presenter.rs`, desktop-only; client | — | 0 | no |
| Daily recap | setting `daily_stats_recap` | frontend only (`components/stats/StatsRecap*`) | — | 0 | n/a |
| Tabby assistant | exp. `assistant` | `commands/assistant.rs`, `services/agent/assistant.rs`, `mcp/web_lane.rs`, `mobile_control/assistant.rs`; core | — (it calls browser + mail) | 0 | ? |
| Web browser | exp. `web_browser` | `commands/browser.rs`, `services/browser_engine.rs`; 6 client, 2 core | Tabby's web lane | 0 | ? |
| Copilot completion | exp. `copilot_completion` | `commands/copilot.rs`, `services/copilot/`; core | ? | 0 | ? |
| Voice | Cargo `voice`/`voice-io` (stub) | `commands/voice.rs`, `services/voice/`, desktop-only; client | — | 6 (whisper-rs(-sys), cpal, alsa(-sys), dasp_sample; tts off Linux) | no |
