# Phone git overview — plan

User ask: "improve the phone git overview: which is the current worktree, which
worktrees exist, what is the current checkout branch, what branches exist".
Read-only. No checkout/switch/create from the phone.

Today the phone has one git fact per project, the dot (`GitDot`,
`mobile-web/src/api.ts:8`), rendered only on Home rows
(`mobile-web/src/screens/Home.tsx:310`, `components/GitMark.tsx`). Worktrees reach
the phone only inside the ＋ sheet's `LaunchOptions` (`api.ts:37,49`).

## 0. Found bug (fix first): the ＋ sheet never lists a worktree

`MobileBridgeHost.tsx:927` mints each worktree id with
`invoke("mobile_opaque_id", { domain: "worktree", … })`, but the allow-list in
`discovery.rs:455-460` (`valid_opaque_control_domain`) has never contained
`"worktree"` (added in 068a578b, worktrees came later in caf5ffb9). The command
(`commands/mobile_control.rs:69-74`) therefore errors, `worktreesOf` drops every
row ("a path too long … is simply not offered", `:929`), and the phone's
"Agents start in" row (`NewTabSheet.tsx:75,101`) is always empty in
production. vitest mocks `invoke` and hides it (`MobileLaunchOptions.test.tsx`
mocks `mobile_opaque_id`). Fix: add `"worktree"` to the `matches!` list, and
extend `mobile_protocol_domains_are_accepted_but_arbitrary_ones_are_not`
(`discovery.rs` tests, ~:1093) with it. Add the guard that would have caught
this: a `#[cfg(test)]` in `discovery.rs` that `include_str!`s
`src/components/mobile/MobileBridgeHost.tsx`, collects every literal
`"mobile_opaque_id", { domain: "<x>"` and asserts `valid_opaque_control_domain(x)`
(plain string scan, no new crate; the two variable-domain calls at `:817`,
`:1413` are covered by the existing list).

Effect: the ＋ sheet's worktree row goes live for the first time. Its pill
(`mobile.newTab.worktree`) stays; the QA item in P3 covers it too.

ID agreement: the sidecar mints nothing for worktrees today (with no window,
`launch_options` answers `worktrees: []`, `host.rs:1376-1384`). The overview's
ids match the bridge's only if both HMAC the **same string** — `Worktree.path`
exactly as `parse_worktree_porcelain` returns it (never canonicalized or
re-joined) — under the same key (`host_key(&state)` is the `AuthStore` key read
from `mobile-control/host.key`, the file `opaque_control_id` reads). The bridge
also drops a path over 256 bytes (`commands/mobile_control.rs:70`); the
overview sends `id: ""` for such a row so it can never name a different one.

## 1. What the user sees

**Entry:** the project screen's name menu (`Project.tsx:421-470`, the dropdown
that already holds 🖼 and 📁) gets a third item, `⎇ Git`, for project scopes
only (`detail.project.kind` absent or `"project"`; boxes and root have none).
`projectMenuOffered` (`Project.tsx:168`) becomes `… || gitOffered`, so every
project has the menu. Home rows stay unchanged.

**`GitSheet`** (a bottom sheet copied from the committed `PromptsSheet.tsx` /
`StatusSheet.tsx` — not `SubagentsSheet.tsx`, which is another session's
untracked file: `sheet-backdrop`
› `option-sheet git-sheet`, `sheet-grip`, header with `sheet-close` ✕ + title +
untested `<small>` pill, `sheet-note` for loading/empty/error), top to bottom:

1. **Head line**: `⎇ main  ↑2 ↓1  origin/main` plus the current worktree's
   `GitMark long`. Detached: `Detached at 1a2b3c4`. No upstream: `no upstream`.
   Not a repo: one `sheet-note` ("Not a git repository") and nothing else.
2. **Worktrees (n)**, shown only when a linked worktree exists (with only the
   project folder the head line already says everything). One row each, the
   current one first and tinted:
   caption = `PROJECT FOLDER` (current) · `MAIN` · `LOCKED` · `MISSING`
   (prunable), several joined with ` · ` (keys in normal case; the reused
   `small` style uppercases); body = label (the leaf name; the **current** row
   shows the project's label — not the main row: a project registered on a
   linked worktree has its main checkout elsewhere) `— ⎇ branch` or
   `— detached 1a2b3c4`, the short `GitMark`, and `2 tabs` when tabs of this
   project run in it.
3. **Branches (n)**: local branches. Order: current first, then those checked
   out in some worktree, then git's own (alphabetical). Each: name, `●` on the
   current one, `in <worktree label>` when checked out elsewhere, `↑a ↓b` when
   non-zero, the upstream name in the caption. Cap 60; a `+N more` row after.
4. **Remote branches (n)**: a collapsed `<details>` of names with no local
   branch of the same short name (`origin/foo` hidden when `foo` tracks it).
   Cap 60, `+N more`.

A ↻ in the footer (`mobile-schedule-actions`, as `StatusSheet.tsx:155-159`) asks
again; the sheet also re-reads on `visibilitychange` to visible. No polling.
An older host (route missing → `ApiError` 404 with code `request_failed`)
shows "The phone host is older than this view — update the desktop".

Why "current" = the project folder's checkout: the phone opens a project, and
the project is registered on one folder; `git_worktree_list` already flags that
worktree `is_current` (`commands/git.rs:3061-3063`, canonical compare). The
desktop Git panel's own worktree *selection* is window state and is not read
(see Open questions). The head line is the current worktree's: branch and
short sha from its porcelain entry (an unborn branch still has a name there),
upstream/ahead/behind from that branch's `git branch` row — no extra spawn.

## 2. API

`GET /api/v1/projects/{project_id}/git` — answered by the sidecar itself, window
open or not (the precedent is `files.rs`, `host.rs:4706-4732`). No new
`DesktopRequest` kind, no `protocol.rs` change, no bridge handler: everything is
a local git read the sidecar already performs headless (`headless.rs:566`), and
the window holds no cached branch data that would make its answer cheaper.

Rust (`services/mobile_control/git_overview.rs`, `#[derive(Serialize)]`):

```rust
pub struct GitOverview {
    pub repo: bool,
    pub head: Option<GitHead>,           // None when !repo
    pub worktrees: Vec<WorktreeView>,    // ≤ MAX_WORKTREES (20)
    pub worktrees_total: u32,
    pub branches: Vec<BranchView>,       // local, ≤ MAX_BRANCHES (60)
    pub branches_total: u32,
    pub remote_branches: Vec<String>,    // ≤ MAX_BRANCHES (60)
    pub remote_total: u32,
}
pub struct GitHead { branch: Option<String>, short: Option<String>, upstream: Option<String>, ahead: u32, behind: u32 }
pub struct WorktreeView {
    id: String,                  // key_id(host_key, "worktree", &[wt.path]) — = the ＋ sheet's id; "" when wt.path > 256 bytes
    label: String,               // leaf name; "" for the CURRENT worktree (phone shows the project label)
    branch: Option<String>, short: Option<String>,   // short = 7-char HEAD, detached only
    main: bool, current: bool, locked: bool, missing: bool,
    git: Option<&'static str>,   // GitDot vocabulary; None = clean or not checked
    checked: bool,               // false past MAX_DIRTY_PROBES (8) / the time budget, or for missing/bare/skipped
    tabs: u32,                   // this project's tabs whose cwd lies in it (longest-prefix match)
}
pub struct BranchView { name: String, current: bool, upstream: Option<String>, ahead: u32, behind: u32, worktree: Option<String> /* label */ }
```

Never sent: any path, `lock_reason`, `prunable_reason` (git words that embed
paths), full shas. Every string is capped at 200 bytes (char-boundary
truncation + `…`), so the body stays well under 32 KB.

TS (`mobile-web/src/api.ts`, next to `LaunchOptions`): the same shapes as
`GitOverview`, `GitHead`, `GitWorktreeView`, `GitBranchView` (`git?: GitDot`),
plus `getGitOverview(projectId, signal)` modelled on `getLaunchOptions`
(`api.ts:54-61`), returning `{ outdated: true }` on a route-level 404.

Errors: unknown id → 404 `project_not_found`; box/root → 404 `not_a_project`
(the `files_scope` kind check, `host.rs:4671`); catalog unreadable → 503
`catalog_unavailable` (the `launch_options` ladder, `host.rs:1357-1365`). An
older host answers the route with a bodiless 404 (`serve_asset` never SPA-falls
back under `/api/`, `host.rs:4837-4841`), i.e. `ApiError` code
`request_failed` — the `api.ts:968` precedent.

No new Mobile switch gates the route: the ＋ sheet already sends worktree leaf
names and branch names ungated. New exposure is remote-branch names only.

## 3. Backend

- **Reuse, made `pub(crate)`** in `commands/git.rs`:
  `git_worktree_list_blocking` (`:3044`; call with
  `(root, Some("mirror".into()), None)` — the bridge's exact call; a local
  project ignores `site`, and `mirror` can never pick the SSH side) and
  `git_branches_blocking` (`:2326`, one `git branch -a --format …` spawn,
  `is_current`/`upstream`/ahead/behind via `parse_track` `:755`). Both run
  through `run_git` → `git_command_in` (`:478`): hooks pinned off,
  `GIT_OPTIONAL_LOCKS=0` (`:183`, so no index.lock race with an agent's
  commit), repo config sanitized, plus the `local_non_repo` short-circuit
  (`:589`).
- **Per-worktree dot** (on git's own `wt.path`, never a phone-supplied path):
  - current row: `headless::git_dot_for(root)` (`headless.rs:566`) — the same
    ladder as Home's headless dot;
  - linked rows: one `git status --porcelain --branch` via
    `hardened_git_command_in(wt.path, …)` (dirty/staged), and `unpushed` from
    that branch's `ahead > 0` in the branch list — not `git_dot_for`, whose
    `unpushed_base` costs 1–3 more spawns per row. A detached or upstream-less
    linked row can then read clean where Home's ladder would say unpushed;
    accepted.
  - skipped (`checked: false`): prunable, bare, a `wt.path` that no longer exists, and any
    `wt.path` for which `remote_target_for_dir(&wt.path)` is `Some` —
    `.git/worktrees/*/gitdir` is project-folder content (attacker-controlled)
    and can name a remote project's registered directory, which would turn a
    status read into an SSH spawn from the sidecar.
  - order: current first, then by tab count; stop at `MAX_DIRTY_PROBES` (8)
    or a **3 s total budget** checked before each probe (mandatory, not a later
    mitigation); the rest report `checked: false`.
- **Drop from the branch list** any row whose name contains whitespace — no
  legal refname can, and it is exactly git's `(HEAD detached at …)` /
  `(no branch, rebasing …)` pseudo-row. (`GitBranch` carries no refname, so the
  plan's former "refname starts with `refs/`" test is not possible without
  changing the shared fn; don't.) `*/HEAD` is already skipped (`:2348`).
- **Remote projects:** not reachable — mobile scopes are local-only
  (`discovery.rs:642-646` `mobile_local`, `MobileBridgeHost.tsx:377-390`
  `mobileProject`), so no SSH probe can happen for the project itself. The
  handler need not re-check the root (the catalog only holds `mobile_local`
  scopes, and `remote_target_for_dir` matches projects.json's directory string,
  which the canonical `root` may not equal); the per-worktree check above is
  the one that matters. Container/VM projects are excluded by the same gate.
- **New module** `services/mobile_control/git_overview.rs` (AppHandle-free):
  `assemble(worktrees, branches, dots, tab_cwds, host_key, project_root) ->
  GitOverview` — pure, all ordering/capping/labels/ids/tab counts here;
  `probe(root, host_key, tab_cwds) -> GitOverview` — blocking: list, branches,
  dots under the cap and budget, then `assemble`. Tab → worktree: canonicalize
  both sides (fallback: lexical), compare by `Path` components, longest match
  wins — never a string prefix (`/p/a` vs `/p/ab`; Windows `C:/` vs `C:\`;
  macOS `/var` vs `/private/var`);
  `Cache` — per raw project id, `(Instant, GitOverview)`, `TTL = 5 s` (shorter
  than `READING_TTL` so ↻ after a desktop checkout is near-live).
- **host.rs:** route next to `launch-options` (`:4899-4902`); handler
  `project_git` = authenticate → `catalog(&state)` → `project(&id)` → kind
  check → cache hit or `tokio::task::spawn_blocking(probe)` (as
  `headless_git_dot`, `host.rs:491-500`). New `HostState` field
  `git_overview: Arc<Mutex<git_overview::Cache>>` (`host.rs:74-92`, built at
  `:5002` and the test builder `:5180`). Tab cwds come from
  `ResolvedProject.tabs[*].cwd` (`discovery.rs:269`). Host key via
  `host_key(&state)` (`host.rs:400`), the key `headless.rs:94` uses for ids.
- `headless.rs` is not touched (another session has edits there).

## 4. Desktop bridge, i18n, register, maps

- **Bridge:** no change. (Phase 0 is a Rust allow-list fix; the bridge already
  calls the command correctly.)
- **i18n** (`src/lib/i18n.ts` + `i18nDicts/{de,es,fr,it}.ts`; parity is enforced
  by `src/__tests__/shell/i18n.test.ts:53-96`, so all five): `mobile.gitSheet.`
  `menu` "Git", `title` "Git · {label}", `loading`, `failed`, `notRepo`,
  `hostOld`, `detached` "Detached at {sha}", `noUpstream`, `worktrees`
  "Worktrees ({count})", `branches` "Branches ({count})", `remoteBranches`
  "Remote branches ({count})",
  `tabsHereOne` "1 tab" + `tabsHere` "{count} tabs" (the `countOne` pattern,
  `i18n.ts:96`), `inWorktree` "in {name}", `more` "+{count} more",
  `notChecked` "changes not checked", `refresh`; captions `projectFolder`
  "Project folder", `main`, `locked`, `missing` in normal case. Arrows
  `↑ ↓ ● ⎇` are glyphs, not text. Add the keys as one block right after
  `mobile.project.files` (`i18n.ts:123`, and the same spot in each dict) —
  another session has an uncommitted hunk at `i18n.ts:109-114`; keep ≥ 8 lines
  clear of it so the hunks stay separable.
- **Untested:** one row `"mobile.project.gitOverview"` in `src/lib/untested.ts`
  after `mobile.projectFiles` (`:457`) — **not** next to `mobile.project.git`
  (`:489`): another session's uncommitted row sits at `:494` and the hunks
  would merge. Pill in the sheet title (`<h2>… <small>`, as
  `StatusSheet.tsx:93`) and on the menu item (`isUntested`, as
  `Project.tsx:470`). `npm test`'s `UntestedRegistry` audit needs the row
  referenced, which `GitSheet.tsx` already does in P2.
- **File maps:** `docs/filemap_backend.md:88` (`mobile_control/` row) — one
  clause: "`git_overview.rs`: `GET /api/v1/projects/{id}/git`, sidecar-answered
  with or without a window: worktrees (opaque ids = the ＋ sheet's), branches,
  dots; hardened reads, 5 s cache"; `docs/filemap_frontend.md` — a row for
  `mobile-web/src/screens/GitSheet.tsx` beside the other `mobile-web/` rows
  (`:22-25`).

## 5. Tests and gates

Rust (`git_overview.rs` `#[cfg(test)]`):
- `assemble`: current-first ordering; caps + totals; remote names hidden when
  a local branch tracks them; `in <label>` mapping; detached head → `short`,
  no branch; prunable → `missing`, `checked: false`; 200-byte truncation on a
  char boundary; tab counts by longest component match (a tab in
  `<root>/.tabtivity/worktrees/a` counts for `a`, not main — use
  `brand::WORKTREES_DIR`, never the literal); no field contains the root path
  (serialize and assert the root string is absent).
- `probe` on a temp repo (plain `git init`/`commit`/`worktree add`/`checkout
  --detach`; `commands/git.rs`'s `init_repo` `:3443` / `plain_git` `:5101` are
  private to its test module, so write a local helper with
  `-c user.name=t -c user.email=t@example.invalid` and skip when `git` is
  missing, as `git_available()` does there): two worktrees, one dirty → dot
  `dirty` on that row only; detached-HEAD row not in `branches`; tab-cwd
  matching through a symlinked temp dir (macOS `/private/var`, memory:
  cross-OS path tests).
- `discovery.rs`: `"worktree"` in `mobile_protocol_domains_are_accepted_but_arbitrary_ones_are_not`
  (~`:1093`), plus the `MobileBridgeHost.tsx` domain-scan guard (§0).
- `git_overview.rs`: an id from `assemble` equals
  `opaque_control_id(state_dir, "worktree", path)` for the same key file — the
  cross-surface agreement, not just `key_id` against itself.
- `host.rs`: route answers 404 `not_a_project` for a box scope, and the cache
  serves a second call inside the TTL (follow the existing router tests'
  fixture around `:5180`).

vitest:
- `src/__tests__/mobile/MobileGitSheet.test.tsx` (fetch-mock pattern of
  `MobileProjectFiles.test.tsx:31-40`): renders head/worktrees/branches; hides
  worktrees section with only main; `+N more`; not-a-repo note; 404 → host-old
  note; ↻ re-fetches.
- `MobileProjectScreen.test.tsx`: menu shows `Git` for a project, not for a box;
  tapping opens the sheet.

Gates (AGENTS.md): `npm run build`, `npm test`, `cargo test --manifest-path
src-tauri/Cargo.toml`, `npm run lint`, `cargo clippy … --all-targets -- -D
warnings`, `scripts/brand-check.sh`, `git diff --check`; after backend edits
`npm run backend:stale` and report it. `npm run build` already runs
`mobile:bundle` (via `mobile:build`), so no separate step is needed.
Not run live — the sidecar must be on the new binary (frozen dev build after
commit) for the route to exist.

## 6. Phases (each passes the gates alone)

**Shared tree.** Other sessions have uncommitted edits in `Project.tsx`,
`style.css`, `discovery.rs`, `headless.rs`, `MobileBridgeHost.tsx`, `i18n.ts`
+ dicts, `untested.ts`, `App.tsx`, `Terminal.tsx`, and an untracked
`SubagentsSheet.tsx`. Never commit, stash, revert, reformat or "fix" their
hunks; never `git stash`/`checkout --` for a baseline (use a worktree). Commit
only your hunks through a private index (`GIT_INDEX_FILE` + `git apply
--cached` of your hunks, `git hook run pre-commit`, HEAD-unchanged check,
`update-ref`, then `git hook run post-commit` so the dev build queues). Gates
run on the shared tree, so a failure in someone else's hunk is reported, not
fixed.

**P0 — worktree id fix.** `src-tauri/src/services/mobile_control/discovery.rs`
(allow-list + domain test + the `MobileBridgeHost.tsx` scan guard). That file
has another session's uncommitted hunks (`:611`, `:988`, `:1416`); yours are at
`:455-460` and the test module — commit via private index with only them.
`npm run backend:stale` after.

**P1 — backend endpoint.** `src-tauri/src/commands/git.rs` (two `pub(crate)`),
new `src-tauri/src/services/mobile_control/git_overview.rs`,
`src-tauri/src/services/mobile_control/mod.rs` (`pub mod git_overview;`),
`src-tauri/src/services/mobile_control/host.rs` (field, route, handler,
tests), `docs/filemap_backend.md`. The phone ignores the route until P2.

**P2 — phone sheet, unwired.** `mobile-web/src/api.ts` (types +
`getGitOverview`), new `mobile-web/src/screens/GitSheet.tsx`,
`mobile-web/src/style.css` (`.git-sheet` rows: extend the existing
`.subagent-index-list button` selectors at `style.css:907-911` with
`.git-rows > li` rather than a new look; current row tint reuses the accent
the status sheet uses), `src/lib/i18n.ts` + four dicts, `src/lib/untested.ts`,
`src/__tests__/mobile/MobileGitSheet.test.tsx`, `docs/filemap_frontend.md`.

**P3 — wire + docs.** `mobile-web/src/screens/Project.tsx` (menu item,
`gitOffered`, sheet state; other sessions are editing this file — small hunk
beside the 📁 item), `src/__tests__/mobile/MobileProjectScreen.test.tsx`, a
sentence in `DOCUMENTATION.md`'s Mobile section (`rg -n "Mobile" DOCUMENTATION.md`
to find it) and in `docs/help/mobile.md` (compiled into the binary:
`cargo test`'s `real_corpus_parses` must pass, `backend:stale` after), and a QA
item in `todo/group-h-crossplatform.md` after `31bx` (`:3749`) in that item's
exact shape: `- [~] **31by — …** (date; untested ids …)`, then
`- [x] 🤖 Automated test`, `- [ ] 🖐️ Manual test` with the eight ✅/❌ children
for Linux (X11), Linux (Wayland), Windows, macOS. Steps cover the ＋ sheet's
"Agents start in" row too (P0 makes it work for the first time). Re-check the
next free id at commit time (`rg -n "31b[a-z]" todo/`) — two other uncommitted
mobile plans may claim `31by` first.

## 7. Open questions / risks

- **"Current worktree" meaning.** Plan: the project folder's checkout,
  captioned `PROJECT FOLDER` (not "this project": with agents in linked
  worktrees, "this" is ambiguous). Agents' worktrees show as the per-row tab
  count. A per-tab "here" (`?tab=<public tab id>` marking the worktree that
  tab's cwd falls in, entered from Focus) is a cheap follow-up — the sidecar
  already holds every tab's cwd — but not in this plan. The desktop Git
  panel's selection is window-only state and would need a bridge kind; not
  worth it.
- **Cost on big repos.** Each hardened git spawn also runs 1–2
  `git config --list --file` sanitize spawns (`sanitize_repo_git_config`,
  `git.rs:309`). Per request: list + branches (~4–6 processes), the current
  row's `git_dot_for` (status + `unpushed_base` 1–3 + log, ~6–12), each linked
  row's status (~2–3). At the cap that is ≈ 40 short processes, once per 5 s
  per project at most, only while the sheet is asked; all inside
  `spawn_blocking`. The 3 s budget bounds the dots, not a single slow
  `git status` already started (no kill); a monorepo can still take one
  status's worth past it. ↻ inside the TTL returns the cached answer.
- **Branch order** is alphabetical (shared `git_branches_blocking` format);
  recency (`--sort=-committerdate`) would need a variant of the shared fn —
  deferred unless the user wants it.
- **Project in a repo subfolder** reads as "not a repo" (`local_non_repo`
  tests `<dir>/.git`), same as today's dot. Kept consistent.
- **Tiny follow-up (not in scope):** tapping a linked worktree row could open
  the ＋ sheet preselected on it — the ids already match after P0. Needs the
  window, as worktree creates do today (`host.rs:1376-1384`).
- Remote-tracking freshness is "as of the last fetch"; the sheet does not fetch.

## Review (2026-10-04)

Verdict: ready with the changes below (made in place). Citations were checked
against the working tree; most were right.

Confirmed:
- §0 bug is real: `"worktree"` was never in `valid_opaque_control_domain`
  (068a578b, 2026-08-26) while `worktreesOf` (caf5ffb9, 2026-09-26) mints with
  it and swallows the error, so the ＋ sheet's "Agents start in" row has never
  shown in production. The fix is right and narrow; the ids agree with the
  sidecar's (same `host.key`, same HMAC input) as long as the raw porcelain
  path is hashed.
- `git_worktree_list_blocking`, `git_branches_blocking`, `parse_track`,
  `local_non_repo`, `git_dot_for`, `HostState` (`:74`, built `:5002`/`:5180`),
  `host_key`, `files_scope`, the `.subagent-index-list` CSS (committed), the
  i18n parity test and the untested audit all exist and do what the plan says.
  Hooks off and `GIT_OPTIONAL_LOCKS=0` apply to every spawn; `spawn_blocking`
  keeps the runtime free.

Changed:
1. §0: named the test to extend (the plan pointed at the wrong one); added a
   guard test that scans `MobileBridgeHost.tsx` for opaque-id domains; spelled
   out what id agreement needs (raw path, same key, the 256-byte rule → `id: ""`);
   noted that the ＋ worktree row goes live for the first time.
2. §1: copy the sheet from the committed `PromptsSheet`/`StatusSheet`, not the
   other session's untracked `SubagentsSheet.tsx`. The caption is `PROJECT FOLDER`.
   The blank label now marks the **current** row, not the main one, which was
   wrong for a project registered on a linked worktree. Said where the head
   line's facts come from.
3. §3: drop the detached pseudo-row by whitespace in its name. `GitBranch` has
   no refname, so the planned `refs/` test could not be written. Pass
   `site: mirror` as the bridge does. Each linked worktree gets one status
   spawn plus the branch's `ahead`, not a full `git_dot_for`. Skip a
   worktree whose path `remote_target_for_dir` recognises: `.git/worktrees/*/gitdir`
   is attacker-controlled and could otherwise cause an SSH spawn. The 3 s budget is
   now mandatory. Tab→worktree matching compares whole path components after
   canonicalizing, never string prefixes. Dropped the redundant root remoteness
   re-check.
4. §2: the not-a-project error now cites the `files_scope` precedent, the
   bodiless-404 detection of an older host now cites its code, and the plan
   says why the route has no new switch.
5. §4: plural keys (`tabsHereOne`), captions in normal case, and the i18n and
   untested rows placed away from other sessions' hunks (`untested.ts:494`
   would have merged).
6. §5/§6: own git test helpers (the git.rs ones are private), identity flags,
   symlinked-tmp case, cross-surface id test; `npm run build` already bundles
   the PWA; a shared-tree rule (no stash/revert/commit of others' hunks,
   private index + hooks); `docs/help/mobile.md`; the exact QA item shape
   (🤖 + 🖐️ + eight children) and the `31by` id race.
7. §7: corrected the cost estimate (sanitize spawns roughly double it) and
   stated the decision on "current".

Decisions for the user:
- Is "current" = the project folder's checkout right, or do you want the
  per-tab "here" from Focus (cheap follow-up, §7)?
- Linked worktree dots skip `unpushed_base`, so a detached or upstream-less
  linked worktree can read clean where Home would say unpushed. OK?
- Remote branch names go to the phone with no switch (the ＋ sheet already
  sends local branch and worktree names). OK?

Remaining risks: never run live (the route needs the frozen dev build); one
slow `git status` can overrun the budget (nothing is killed); P0 changes
behaviour in the ＋ sheet that has never been exercised live.
