# Structure budget — plan

> **Status (screened against code 2026-11-22):** NOT-STARTED. No size-budget gate (no script under `scripts/`, nothing in `scripts/gates.sh` or `ci-cd.yml`), no import-boundary
> gate, no dead-code report and no `CONTRIBUTING.md`. The file-split work it builds on landed (`docs/code_screen_plan.md` S5/S7). Not live-tested unless the doc/todo says so.

History: plan only (2026-10-26), reviewed by two plan reviewers the same day.
Revised 2026-11-14, not re-reviewed: step 4 is an import-boundary gate
instead of per-add-on Cargo features; raising a baseline number needs the
user's say-so; a new plan declares core or add-on; the numbers are
re-counted. No code changed and no step has landed. Builds on
`docs/code_screen_plan.md` section S, which owns the file splits; its S5 and
S7 landed on 2026-10-26 (`docs/code_screen_handoff.md`), so nothing here
waits for them any more. This plan adds the guard that keeps the result from
regrowing, a boundary for the optional features, and the process rules
around them. U1–U3 decided 2026-10-26, U5 and U6 on 2026-11-14 (see "User
decisions"); U4 is approved at step 5.

## Why

The tree was ~870k lines on 2026-10-26 (desktop TS 490k, Rust 340k, phone
37k), written in five months, mostly by agents, with one human maintainer.
By decision 1's count (tests and dictionaries left out) it is 716k lines in
1,756 files on 2026-11-14; 104 of them are over 1,500 lines (107k lines over
that limit). The largest are `src-tauri/src/services/mobile_control/host.rs`
(9,220), `src-tauri/src/commands/mail.rs` (5,849),
`src-tauri/src/commands/projects.rs` (5,640), `src/stores/tabs.ts` (4,665),
`src-tauri/src/terminal/mod.rs` (4,440). Agents grow big files fastest,
because a big file is where the code they need already is.

Splits alone do not hold. In the 19 days after this plan was written, S7
took `FileViewerPane.tsx` from 10,870 lines to 406 and the tab store from
6,888 to 4,665, and the number of oversize files still rose from 99 to 104:
`mobile_control/host.rs` 7,952 → 9,220, `commands/project_transfer.rs`
3,091 → 3,945, and two files created on 2026-10-26 passed 3,000 lines
(`services/mcp/git_push_mcp.rs` 2,457 → 3,107, `services/mail/mail_pgp.rs`
2,111 → 3,613). Step 1 is the one step that stops this, so it lands first
and alone. Two goals:

1. **Maintainability:** every file small enough to read whole; a split that
   lands stays split.
2. **Scope:** the three pillars (project desktop, remote/HPC, phone) are the
   core; the workspace apps around them are add-ons that can be frozen and
   that the core does not depend on.

The add-ons are about a tenth of the tree (appendix: ~47k Rust, ~38k TS) and
hold 63 of the 1,019 open untested pills (`npm run untested -- list`,
2026-11-14: mobile 326, agents 141, layout 112, projects 90, embed 75,
files 64; mail 46, calendar 17). Freezing add-ons bounds little by itself;
the size gate and step 5's rules are what act on the core.

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
   needs the user's say-so, named in the commit message (2026-11-14: a
   reason alone is not enough, an agent can always supply one). A file moved
   by an S step takes its entry along in the same commit.
4. **One node script, no dependency.** `scripts/size-budget.mjs`, not ESLint
   `max-lines` (ESLint never sees the Rust half, and ~100 per-file overrides
   would swamp `eslint.config.js`) and not clippy `too_many_lines` (pedantic,
   hundreds of hits today). Function length is not gated in this plan.
5. **Add-ons reuse what exists.** Runtime switch: the existing
   `useExperimental` flags (`src/lib/experimental.ts`) and the plain settings
   toggles that already gate an add-on (`todo_board`, `daily_stats_recap`, …).
   Boundary: an import check in the size budget's shape (step 4), for Rust
   and TypeScript alike. No new Cargo feature (`voice` keeps its own), no
   add-on framework, no per-add-on frontend bundle.
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
   `lib.rs`'s `generate_handler!`, `scripts/gates.sh`, `ci-cd.yml`,
   `scripts/ci-local.sh`) are edited by one step at a time; parallel
   implementers list their edits in the handoff and the main agent applies
   them at merge.

## User decisions

U1–U3 decided 2026-10-26, U5 and U6 on 2026-11-14; the Cargo-feature
column of U2 was dropped on 2026-11-14 with step 4's change.

- **U1 Core — decided:** project desktop + boxes, agents and terminals,
  files/viewers/editors (incl. PDF and LaTeX), Git, remote/HPC/sync, phone
  app, the fence. Never frozen. Everything else is an add-on; U5 says
  where the subsystems this list does not name belong.
- **U2 Add-on fate — decided:**

  | Add-on | Frozen (fixes only) |
  |---|---|
  | Print manager (+ the print MCP lane) | yes |
  | Deck presenter | yes |
  | Daily recap | yes |
  | Web browser | yes |
  | Mail (+ mail AI, OpenPGP) | no, active |
  | Calendar/CalDAV + to-do board | no, active; **one** add-on (shared store) |
  | Tabby assistant, Copilot completion | no, active (not asked: default) |
  | Voice | no, active |

  Nothing is removed. Every row is an add-on in step 4's boundary table.
  Freezing the web browser also freezes what Tabby's web lane can gain
  through `browser_engine::fetch_for_agent`; a fix there is still allowed.
  Couplings the boundary baseline starts with: calendar and to-do share one
  store (`calendar_load`/`_save` carry both; `services::server::features_of`);
  Tabby's web lane fetches through the browser's
  `browser_engine::fetch_for_agent` and sanitises with mail's
  `mail_sanitize`; mail, calendar and to-do are also served by the daemon
  and have a runtime switch there (gateway `policy.json` `features`, the
  user's `disabled_features`).
- **U3 Limit — decided:** 1,500 lines.
- **U4 Wording** of the three AGENTS.md rules in step 5 — still open; the
  step-5 implementer drafts it and the user approves before it lands.
- **U5 Subsystems U1 does not name — decided 2026-11-14: all core.** The
  hosted server (gateway, daemon, sharing), the root console and cockpit,
  the agent MCP lanes (cockpit, git push, markup, help), checkpoints and
  diff notes, the localhost and TensorBoard viewers and scaffold files each
  extend a pillar U1 names, so they are core and never frozen. Only the
  print MCP lane is an add-on (part of the print manager, above). So that
  the list cannot go stale again, a new plan states its class (step 5,
  rule c).
- **U6 Form of step 5's rule (b) — decided 2026-11-14: ratchet with the
  user's say-so.** As written on 2026-10-26 ("a new feature in an active
  area lands with, or after, a fix or a verified item in the same area") the
  rule could not fail: some fix always came before. It becomes a per-area
  cap on the open untested pills, raised only with the user's say-so
  (step 5).

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
exists, writes it from the current tree (104 entries on 2026-11-14, 107k
lines over the limit; 175 files would be over 1,000). After that only
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
  sibling `tests.rs`, never delete tests; raising a baseline number needs
  the user's say-so".
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

S5 and S7 landed on 2026-10-26 and several files they touched are still
among the largest (`commands/mail.rs` 5,849, `commands/projects.rs` 5,640,
`stores/tabs.ts` 4,665, `commands/ollama.rs` 4,227, `git_peer.rs` 4,167,
`FileTree.tsx` 4,053, mobile `Terminal.tsx` 3,223; S7's Rust function
splits were not done). So the order is taken fresh from `--report` on the
day this step starts, never from a list in this file.

First, cheapest: the Rust files over only because of an inline
`mod tests { … }` (24 by a rough recount on 2026-11-14; `--report` lists
them) get S1's move to a sibling `tests.rs` — mechanical, check
`include_str!` source-scan tests first.

Then an **S7b** list in `docs/code_screen_plan.md`: the 15 oversize files
with the most commits in the last 30 days (`git log --since=30.days
--format= --name-only | sort | uniq -c`, joined with the baseline), ties
broken by lines over the limit. That is round 2's criterion
(`docs/structure_split_plan.md`: a file's size costs something only when
someone has to open it); size alone would put rarely edited files first.
Left out: `src-tauri/src/lib.rs` (3,188; ~850 of its lines are the one
`generate_handler!` list, which cannot be split) and files that have their
own plan (`PdfViewer.tsx`: `docs/pdf_viewer_split_plan.md`; the phone
composer, `AgentsPanel`, `TexView`: `docs/structure_split_plan.md`).

For scale, the 15 largest on 2026-11-14:
`services/mobile_control/host.rs` 9,220 · `commands/mail.rs` 5,849 ·
`commands/projects.rs` 5,640 · `stores/tabs.ts` 4,665 ·
`terminal/mod.rs` 4,440 · `commands/ollama.rs` 4,227 ·
`services/git/git_peer.rs` 4,167 · `commands/apps.rs` 4,151 ·
`services/mail/mail_store.rs` 4,111 · `services/root_mcp.rs` 4,083 ·
`files/FileTree.tsx` 4,053 · `lib/viewers/tex/tex.ts` 4,041 ·
`commands/project_transfer.rs` 3,945 · `sysstat.rs` 3,621 ·
`services/mail/mail_pgp.rs` 3,613.

One file per commit, each running `--update <old> <new…>` so the baseline
shrinks with the split; a moved file takes its entry along (decision 3).
A split of `mobile_control/host.rs` puts each add-on's routes (mail,
calendar, to-do) in a module of their own, as `mobile_control/assistant.rs`
already is, and names that module in step 4's table.
Code screen rules: quiet tree, the user's go-ahead per S step, `git mv` of
the original to the part that keeps most of it, for blame.

### Step 3 — Add-on inventory (read-only)

For each add-on of U2, one row in the appendix (a head start is there):

| Add-on | Runtime gate | Its paths (Rust / desktop TS / phone) | Rust module names | Wiring files | Core → add-on crossings | Lines (TS / Rust) | Daemon? |

Sources: `src/lib/experimental.ts`, `src-tauri/src/schema/settings.rs`, the
filemaps, `services::command_class`, `services::server::features_of`,
`commands/mod.rs`, `mobile_control/host.rs`'s `/api/v1/*` routes, the root
MCP tool families (`root_mcp_security.rs`). "Its paths" and "Rust module
names" become step 4's `addons` table. "Wiring files" are the places where
an add-on is registered, listed, migrated or exported, and nothing else is
done with it; step 4 allows those. "Core → add-on crossings" is everything
else outside the add-on that reaches into it; step 4 records those as the
baseline and 4.1 cuts the cheap ones. No user question (U2 is decided).

### Step 4 — Add-on boundary gate

The boundary is a rule on imports, checked in both languages: **code outside
an add-on does not reach into it**, except from a wiring file. An add-on may
use the core freely. One add-on reaching into another is a crossing too
(Tabby → browser → mail's sanitiser), so those couplings stay visible.

New `scripts/addon-boundary.mjs`, no dependency, the size budget's shape:

- File list and exclusions as in decision 1 (a test may import anything).
- **TypeScript** (`src/`, `mobile-web/`, `shared/`): every `from "…"` and
  `import("…")` specifier that is relative (the repo has no path alias) is
  resolved against the file list (`.ts`, `.tsx`, `/index.ts(x)`); a
  specifier that lands in an add-on's paths from a file outside them is a
  crossing.
- **Rust** (`src-tauri/`, `src-core/`, `src-serverd/`, `src-gateway/`): a
  non-comment line outside the add-on's paths that names one of its modules
  as a path segment (`mail_engine::`, `::mail_sanitize`, `services::mail`,
  `commands::calendar`) is a crossing. Text match, no parser: the module
  names are distinctive, and a generic one (`mail`, `calendar`, `voice`)
  counts only next to `::`.
- Default mode: exit 1 listing every crossing that is neither in a wiring
  file nor in the baseline (`file → add-on  (line)`), else one line
  (`add-on boundary: ok, N crossings on the baseline`). A baseline entry
  that no longer crosses is noted (`K entries can go: --update`), never a
  failure.
- `--update [<path>…]`: drops baseline entries that no longer cross; never
  adds one. With paths, touches only those files' entries (the shared tree
  holds other sessions' edits, as in step 1).
- `--init`: writes the baseline from the current tree; refused once the
  file has one.
- `--report`: crossings per add-on, most first — the list 4.1 and the S7b
  splits work down.
- Spells no brand name (`scripts/brand-check.sh` reads `.mjs` and the JSON).

New `scripts/addon-boundary.json`, three parts:

- `addons`: name → `paths` (path prefixes and files) and `rust` (module
  names), from step 3. A new add-on file outside the listed paths counts as
  core, so a new add-on, or a new folder of an old one, gets its row in the
  commit that creates the file.
- `wiring`: file → role, the files step 3 found. Candidates (step 3
  confirms each): Rust `lib.rs` (command registration), `commands/mod.rs`,
  `services/mod.rs`, `services/command_class.rs`, `schema/` (types never
  move), `services/server/mod.rs` (`features_of`),
  `root_mcp/root_mcp_security.rs` (tool families), and the code that
  migrates, exports or re-keys add-on state (`brand_migration`,
  `project_transfer`, `server/vault/rotation.rs`); TS the tab-kind switch
  (`tabs/TabPane.tsx`, `layout/AppShell.tsx`, `layout/DetachedApp.tsx`,
  `fileViewer/lazyViewers.ts`), `layout/SettingsPanel.tsx`,
  `lib/experimentalSweep.ts`, `src/App.tsx`, `mobile-web/src/App.tsx`.
  `mobile_control/host.rs` is **not** wiring: its add-on routes go on the
  baseline and leave with its split (step 2).
- `baseline`: file → the add-ons it reaches today. Only shrinks. Adding an
  entry or a wiring file is a hand edit, visible in the diff, and needs the
  user's say-so, named in the commit message.

Head start, rough counts on 2026-11-14 (step 3 re-checks; wiring files not
yet taken out). Rust files outside the add-on that name one of its modules:
mail 38 (most only for `install_crypto_provider`), calendar + to-do 19,
browser ~12, Tabby ~8. TS files outside that import from it: calendar +
to-do 30, mail 19, voice 17, Tabby 6, presenter 5, browser 4, recap 3,
print 2.

Wire it in, as step 1 does for the size budget:

- `scripts/gates.sh`: `gate boundary 1 node scripts/addon-boundary.mjs`
  after `gate size`; the `--list` heredoc row and the header comment's
  `always` line.
- `.github/workflows/ci-cd.yml`: a step in the `lint` job beside the size
  budget's; `scripts/ci-local.sh`: its `STEPS` row
  (`boundary|lint|<exact step name>|ci|always`).
- `AGENTS.md` Gates block: one line,
  `scripts/addon-boundary.mjs   # core never imports an add-on; listed crossings only shrink`.
- Filemap: a row beside the size budget's in `docs/filemap_backend.md`.

Tests: vitest with throwaway repos, like step 1's
(`src/__tests__/shell/AddonBoundary.test.ts`, run by hand after a change to
the script alone). Cases: a new core → add-on import fails, in TS and in
Rust; add-on → core passes; a wiring file passes; a baselined crossing
passes and `--update` drops it once it is gone; `--update` never adds; a
Rust mention in a comment and an import from a test file are ignored; an
add-on → add-on import fails.

#### 4.1 — Cuts (optional, one per commit)

Each is a pure move that empties part of the baseline; the commit runs
`--update <its files>`.

- `install_crypto_provider` (the process-wide rustls provider, nothing in
  it is mail's) moves out of `services/mail/mail_engine.rs` into a shared
  module; 22 references outside mail follow it. This clears most of mail's
  Rust entries.
- `mail_sanitize::sanitize_message_html` is called by
  `services/browser_engine.rs` for the web lane. It moves beside the parts
  `app-core`'s `web_safety` already took from `mail_sanitize` (if `ammonia`
  may live in `app-core`; else a shared module in `services/`), and
  `mail_sanitize` re-exports it as it does for those.
- Shared date and alert helpers that sit in an add-on's folder but are used
  across the core (`common/DateField.tsx` and the prompt charts import from
  the calendar's; `lib/alerts.ts` from mail's and the calendar's): step 3
  names which are helpers that belong in `src/lib/` and which are real
  uses of the add-on.

No Cargo feature is added by this plan; why, and when mail's comes back,
is under "Later".

### Step 5 — Process rules and backlog triage

- `AGENTS.md` Conventions, wording per U4:
  (a) *Frozen add-ons (print manager, deck presenter, daily recap, web
  browser): bug and security fixes only; a new feature there needs the
  user's say-so.*
  (b) *An area's open untested pills never exceed its number in
  `scripts/untested-baseline.json`: a new pill needs one of that area
  stamped tested first, or the user's say-so to raise the number.*
  (c) *A new `docs/*_plan.md` states `Class: core` or `Class: add-on
  (<name>)` in its status block; a new add-on gets its row in
  `scripts/addon-boundary.json` in the commit that creates its first file.*
- Untested ratchet (rule b, U6): a `budget` command in
  `scripts/untested.mjs` beside `check`, and
  `scripts/untested-baseline.json` mapping each `area` of
  `src/lib/untested.ts` to its count of open rows (no `tested`) on the day
  it lands — 1,019 in all on 2026-11-14: mobile 326, agents 141, layout
  112, projects 90, embed 75, files 64, lib 59, mail 46, shell 36, header
  28, tabs 25, calendar 17, the rest smaller.
  - `npm run untested -- budget`: exit 1 naming each area whose open count
    is over its number, or that has no number; else one line with the
    total.
  - Stamping a row tested (`-- tested <id>`, the user's step) lowers the
    area's open count and so leaves room for one new pill. The number
    itself moves only by `-- budget --update`, which lowers each to the
    current count and never raises; run it when the gained ground should
    stay gained.
  - Raising a number, or adding an area, is a hand edit of the JSON,
    visible in the diff, with the user's say-so named in the commit
    message. An agent asks before it adds the pill, not after.
  - `area` is free text: a pill filed under a roomier area to get past the
    cap is a review finding, and the rule's wording says so.
  - Wired like `npm run lint`: `gate untested` in `scripts/gates.sh` on a
    frontend change, a step in ci-cd.yml's `lint` job, its `STEPS` row in
    `scripts/ci-local.sh`, one line in the AGENTS.md Gates block. Tests in
    `src/__tests__/shell/UntestedRegistry.test.ts`: over the number fails,
    an unknown area fails, `--update` lowers and never raises.
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
the size budget and the add-on boundary; `scripts/ci-local.sh` before a
push), `AGENTS.md`
invariants for anyone using an agent, the brand check, `develop` as the PR
target (`main` releases), the file maps, the frozen add-ons, how to pick an
issue. The plan proposes five good-first-issue
candidates (small, one subsystem, testable without a live window); labelling
them on GitHub is the user's step.

### Later — mail as a Cargo feature or its own crate (not scheduled)

Per-add-on Cargo features were step 4 until 2026-11-14 and were dropped
(see "Not done"). Mail's comes back when something needs a build without
mail — a mail-free daemon or package — or as the first move of a crate
extraction. Preconditions: mail's boundary baseline is empty (the core
reaches mail through wiring files only) and has stayed empty for a month;
and code screen S9 (`schema/` in `app-core`), which is still shelved and
needs the user's go-ahead. Both are necessary, not
sufficient: mail also reaches `services::server` (vault/secrets, 17 refs),
`root_mcp`, `agent_fence`, `openvpn`, `vm_proxy`, `ai_switch` and `storage`,
which must sit in `app-core` or behind a trait first; and its commands stay
in `tabtivity` (`build.rs` reads only `src-tauri/src/commands/*.rs`, the
`command_class` test only `commands::…` paths), so a crate holds the
services alone.

The cfg-gating constraints verified on 2026-10-26 are step 4 of this file
at commit 22ded3530 — `build.rs` copying only a single-line `#[cfg]`,
`generate_handler!`'s per-entry cfg against the `command_class` test,
`command_class` rows staying unconditional, migration and re-key code
staying compiled, never a cfg on a `schema/` field, the daemon's and the
cross-OS feature lists. Re-verify them before use.

## Organisation

Shape: **small, low risk**. No step changes behaviour; 4.1's cuts are pure
moves.

- Step 1: one implementer, first and alone; covered by the final review.
- Step 3: one read-only investigator; its table is step 4's input.
- Step 4: one implementer (script, table, baseline, gate wiring) with a
  per-step reviewer who checks the `addons` paths against the tree — a
  missing path makes an add-on's file count as core, and the gate then
  guards nothing there. 4.1: one implementer per cut, sequentially (each
  edits the baseline).
- Step 5: one implementer for the untested ratchet, one for the rules and
  the backlog triage; step 7: one implementer. All covered by the final
  review.
- Step 2: rides code screen S, sequential, user go-ahead per file.
- Step 6: one implementer; deletions reviewed by the final review.

Bound: ≤ 5 subagents at once, ≤ 3 running cargo. Dependencies: 1 → 2;
3 → 4 → 4.1; 1 and 4 run one after the other (both edit `gates.sh`,
`ci-cd.yml`, `ci-local.sh` and the AGENTS.md Gates block), and so does
step 5's untested ratchet; step 5's three rules wait for the user's U4
approval, and rule (c) for step 4's table; the backlog triage and step 6
are independent; 7 goes last (it names the gates of steps 1, 4 and 5).

### Order

1. **Step 1, now.** Every week before `--init` raises the numbers it
   freezes (five more oversize files and 1,268 more lines in `host.rs`
   between 2026-10-26 and 2026-11-14).
2. Step 3, then step 4. `--init` of the boundary baseline has the same
   urgency in small: each new crossing before it is one more entry.
3. Step 5: the untested ratchet as soon as steps 1 and 4 are out of the
   gate files (its baseline grows with every new pill, too), the rules once
   U4's wording is approved; step 2's S7b list any time after step 1.
4. 4.1's cuts, step 6 and step 7 as time allows.

A split that is running in the shared tree (`docs/pdf_viewer_split_plan.md`
on 2026-11-14) is not waited for: `--init` records whatever the files
measure that day, and the split's own commits lower the numbers with
`--update <paths>`.

### Agent steps

| Agent step | Plan steps | Main files | Review |
|---|---|---|---|
| 1 | 1 | scripts/size-budget.mjs, size-budget-baseline.json, gates.sh, ci-cd.yml, ci-local.sh, AGENTS.md | final |
| 2 | 3 | read-only; appendix of this plan | main agent |
| 3 | 4 | scripts/addon-boundary.mjs, addon-boundary.json, gates.sh, ci-cd.yml, ci-local.sh, AGENTS.md | per-step + final |
| 4…n | 4.1 | one cut each: the moved helper, its callers, the baseline | final |
| n+1 | 5 (ratchet) | scripts/untested.mjs, untested-baseline.json, gates.sh, ci-cd.yml, ci-local.sh, AGENTS.md | final |
| n+2 | 5 (rules, backlog) + 7 | AGENTS.md, todo/*.md, todo/someday.md, CONTRIBUTING.md | final |
| n+3 | 6 | scripts/dead-code.sh, package.json | final |
| S7b | 2 | per file | code screen rules |

## Verification

- Size budget: its tests (the over-limit file lives in their temp repo —
  never a scratch file in the shared tree, where other sessions' gates
  would trip on it or commit it); `scripts/gates.sh -n` shows `run size`
  and `--list` lists it; `ci-local.sh --check-drift` and `brand-check.sh`
  pass; `--update` right after `--init` leaves the baseline byte-identical
  (`cmp` against a copy).
- Add-on boundary: its tests (in their temp repos); `scripts/gates.sh -n`
  shows `run boundary` and `--list` lists it; `ci-local.sh --check-drift`
  and `brand-check.sh` pass; `--update` right after `--init` leaves the
  baseline byte-identical; the reviewer's spot check: for each add-on, one
  file picked from the tree is inside its `paths`, and a scratch import of
  it from a core file (in a temp copy, never the shared tree) fails.
- 4.1's cuts: `scripts/gates.sh` for the touched crates; the moved function
  is byte-identical; `npm run backend:stale` after Rust edits.
- Untested ratchet: its tests; `npm run untested -- budget` passes on the
  day's tree and `-- check` still does; `scripts/gates.sh -n` shows it on a
  frontend change; `ci-local.sh --check-drift` passes.
- Backlog: across `todo/*.md` (with `someday.md`), numbered entries and
  `- [ ]`/`- [x]` boxes before = after (moved, not lost); `rg -c '🖐️'
  todo/group-*.md` unchanged per file.
- Dead-code report: exits 0 with a tool missing and names it.
- Nothing here is run live, and nothing needs to be: no step changes what
  the app does.

## Not done

- Deleting or disabling any feature (U2 removes nothing).
- Per-add-on Cargo features, a `built_addons` command and an all-off clippy
  gate (step 4 until 2026-11-14). Dropped because the features would be on
  by default, so no package changes and the off build is one nobody ships or
  runs; they need a "not built" path on four surfaces (desktop, phone, root
  MCP, daemon) and one more clippy variant in every gate run; and they guard
  only the Rust half — the TypeScript side has no per-add-on bundle to
  compile out. Print manager, deck presenter and calendar have 0–3 crates of
  their own, so nothing is saved there either. Mail's (~63 crates) is under
  "Later".
- ESLint `max-lines`, clippy `too_many_lines`, function-length gates.
- Splitting `src/styles/*.css` (`@import` order is load-bearing; code screen
  decision 5), regrouping `commands/*.rs` (`build.rs` parses the flat list).
- Per-add-on frontend bundles.

## Appendix — add-on inventory (step 3)

Head start from the plan review (2026-10-26, rough; step 3 re-checks every
cell and adds the paths, module-name, wiring and line columns; `?` = not
checked). The "Own crates" column is kept for "Later"; step 4 does not use
it. Crossing counts from 2026-11-14 are in step 4.
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
