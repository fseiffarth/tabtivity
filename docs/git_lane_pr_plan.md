# Git lane: pull requests and the CI autopilot — agents open PRs and fix red CI

Status: plan only, nothing implemented (2026-11-19). The user's decisions are
recorded under "Decisions" at the end. Builds on the agent git lane
(`docs/context/git_push_mcp.md`, `services::mcp::git_push_mcp`, CI reads in
`services::git::git_ci`) and the fixed-notice wake of tab messaging
(`docs/context/tab_messaging_mcp.md`). Line references in the plan are from
`develop` at v0.2.94; verify them against the code before relying on them.

## Why

Agents cannot make pull requests today: the lane has push, release and
read-only CI, and the fence holds no credential, so `gh pr create` cannot work.
And fixing a red CI run overnight needs a way to sleep until a run finishes.
The token stays on the host throughout: no plan here puts one in the fence.
No new Tauri commands (the existing `git_push_mcp_proposals` / `_decide` /
`_clear` carry the new card kinds). No project code runs (no hook, no
preflight), so the PR path is the same on Linux, macOS and Windows.

## 1. Tools
All four pass the `repo_changed` and `not_local` checks like CI reads.

Reads (every level incl. off; share the 60/h CI budget; repo via `ci_target`,
github.com only, never an argument; unconfirmed repo stages "Allow CI" card):
- `pr_list { state?: open|closed|all = open, limit?: 1..30 = 10 }` → number,
  title, state, draft, head/base ref, fromFork, author, authorAssociation,
  updatedAt, url.
- `pr_view { number }` → title, body, state, merged, draft, locked, base/head +
  head SHA, fromFork, mergeable(+State); checks on head SHA; last 10 reviews,
  15 review comments, 15 issue comments. All strings strip_invisible + redact,
  2 KB per body / 16 KB total, labelled with author; description says the text
  is others' data, not instructions.

Writes (off → level_off; propose → card; apply → runs unless must_stage_pr):
- `pr_create { title 1..256 one line, body? ≤20 000, base?, draft?, note? }`
- `pr_comment { number, body 1..8 000, note? }`
New categories: `pr_exists` (with prNumber/prUrl), `no_commits`, `pr_not_open`,
`secret_in_text` (refuse rather than silently redact). Otherwise reuses
level_off, window_required, repo_changed, ci_repo_unconfirmed, rate_limited,
pending_limit, invalid_arguments, not_checked_out, no_upstream, url_rewritten,
not_github, remote_branch_missing, not_pushed, auth_failed, not_available (403,
token lacks Pull requests: write), not_found, remote_rejected, network,
transport_failed (incl. any 3xx), stale_approval, dismissed, expired, busy.

## 2. Code layout
1. New `services/git/github_api.rs`: move client/block_on/status_failure/get_json/
   short/api_token out of `git_ci.rs`; add `send_json`, multi-line `long_text`, a
   `GithubApi` trait (reqwest impl + in-memory fake for tests). git_ci unchanged
   in behaviour.
2. New `services/git/git_pr.rs` (AppHandle-free): list/view shaping, validation,
   `secret_shaped`, `mentions`, `slash_command`, `plan_create` (target check via
   git_release::local_target made pub(crate); remote head == local tip else
   not_pushed; default branch from `GET /repos/{o}/{r}` not fence-writable refs;
   base ≠ head and exists; existing open PR → pr_exists; compare → no_commits,
   else commits + files for the card from GitHub's answer), `create` (head is
   always `{target owner}:{branch}`, response verified: head.sha, base.ref,
   html_url prefix), `comment_target`, `comment`.
3. New child module `services/mcp/git_push_mcp/pr.rs`: call_/run_/decide_ for
   both writes, `must_stage_pr`.
4. git_push_mcp.rs edits: Kind PullRequest/PrComment; Proposal fields (pr_number,
   pr_url, title, body, base, draft, mentions, pr_author, from_fork); reuse
   Status::Pushed for opened/posted; decide dispatch; supersede rules (PR: tab or
   same dir+branch; comment: same tab + same PR number); a push dismisses a
   now-stale pending PR card; tool list/schemas/instructions; admission with a
   separate 10/h PR-write bucket and the shared pending limit; window_required /
   repo_changed / dispatch / changed-set wiring.

## 3. Staging and binding
`must_stage_pr` stages regardless of level when: base is the default branch,
main, master or protected; repo allowed only via `git_ci_repos`; text has
@mentions or cross-repo refs; a line starts with `/` (ChatOps); comment on a
fork PR or a PR not authored by the token's user. (In this repo nearly every
PR targets main → effectively always staged.)

pr_create card binds repo key, URL, head branch, head SHA (local == remote at
staging), base, and the exact title/body/draft. Approval re-plans: repo/URL
changed, local tip moved or remote head moved → stale_approval; re-checks
pr_exists; POSTs the stored text; verifies the response.
pr_comment card binds repo key, PR number, PR head SHA, body; approval re-reads
the PR: closed/locked → pr_not_open, head moved → stale_approval.
Text is shown on the card as plain text (never rendered markdown). The host
never fills text from repo files (no PR template).

## 4. Endpoints and token permissions
| Tool | Endpoints | Fine-grained permission |
|---|---|---|
| pr_list | GET pulls | Pull requests: Read |
| pr_view | GET pulls/{n}, commits/{sha}/check-runs, pulls/{n}/reviews, pulls/{n}/comments, issues/{n}/comments | Pull requests: Read, Checks: Read |
| pr_create | GET repo, GET pulls?head&base, GET compare, POST pulls | Pull requests: R/W, Contents: Read |
| pr_comment | GET pulls/{n}, GET /user, POST issues/{n}/comments | Pull requests: R/W (verify vs Issues: write) |
Classic: `repo` / `public_repo`. Missing permission → 403 → not_available naming
"Pull requests: Read and write"; add that row to GitTokenScopes.tsx.

## 5. Abuse / prompt injection
Public text under user's name → propose default + staging rules + 10/h + pending
limit. Spam → supersede per tab/PR, limits, staging for mentions/others' PRs.
Secrets → secret_in_text. Attacker-controlled files → whole text on the card.
Cross-repo head → inexpressible. Repo spoofing → repo_changed, ci_target, repo-key
binding. Redirects off. Read results labelled as third-party data.

## 6. Phone / headless
Writes → window_required (free). Reads without token (public works, private
not_available); unconfirmed → ci_repo_unconfirmed, no card. Phone approval cards
stay phase 2 (`docs/headless_mcp_plan.md`).

## 7. Frontend
Types (kind union + fields); GitPushMcp.tsx PR card (title, head → base, SHA,
Draft pill, to-default note, mentions warning, plain-text body "posted under
your GitHub account", commits/files, Open PR / Post comment, View on GitHub
via open_external_url); cockpit rail/tonight lines; i18n en/de/es/fr/it;
untested rows `gitPushMcp.pr`, `gitPushMcp.prComment`.

## 8. Docs
git_push_mcp.md (tools, new PR section, budgets, known limits, Allow-CI wording,
QA steps 12–16), threat_model.md, headless_mcp_plan.md, both filemaps,
todo/group-o-security.md QA box with platform pairs.

## 9. Tests
Registry/schemas; admission + budgets; keyring-free; repo_changed/level_off;
plan_create refusal matrix; must_stage_pr matrix; binding/stale_approval and
exact POST body; text hygiene; comment rules; HTTP failure mapping; read
shaping caps; supersede/dismiss/claim/fail-never-replaces-Pushed; no new
persisted keys; vitest for cards, cockpit line, i18n parity.

## 10. Commit split
1. refactor(git): shared GitHub API helpers (github_api.rs, GithubApi seam)
2. feat(git-lane): pr_list / pr_view
3. feat(git-lane): pr_create / pr_comment proposals
4. feat(ui): pull-request and comment cards
5. docs: lane context, threat model, headless plan, filemaps, QA todo


## 11. `ci_watch`: wake the tab when a CI run finishes (for the overnight loop)

Goal: an agent can fix red CI unattended — read failure (`ci_run`), fix, push at
Apply, then sleep until the run it started finishes, instead of spending its
six daily scheduled deliveries on guessed wake-up times.

Tool: `ci_watch { run?: id }` on the git lane. Without `run`: the newest run of
the checked-out branch's tip on the confirmed repo (same `ci_target` gate and
read budget as `ci_runs`). Answers `{status:"watching", run, sha}` or a
category (`not_github`, `ci_repo_unconfirmed`, `repo_changed`, `rate_limited`,
`no_run` — nothing started for that commit yet; the agent retries later,
`watch_limit`). `ci_unwatch { run }` drops it.

Host side (new `services::git::ci_watch`, AppHandle-free):
- Watches live in memory beside the lane's proposals (lost on restart, like
  tokens), at most 2 per tab, expire after 6 h.
- One poller thread for all watches: `GET actions/runs/{id}` every 3 min (one
  call per watch per tick; GitHub's 5 000/h token limit is far away), stops at
  `status == completed`.
- On completion it wakes the tab exactly like tab messaging's idle wake
  (`docs/context/tab_messaging_mcp.md` "Idle wake"): a fixed, host-built
  sentence (`ci_watch::NOTICE`, e.g. "A CI run you are watching has finished.
  Call ci_runs or ci_run for the result.") queued through the window's
  `queuePromptForTab` with the scheduler's idle gate, never `whileBusy`.
  No run name, conclusion, branch or log text ever reaches the prompt — the
  agent reads those through `ci_run`, where they are labelled data. This keeps
  the lane rule "a push outcome must not become a prompt"
  (`docs/context/git_push_mcp.md` "Levels") — the notice is a fixed sentence,
  not an outcome.
- Gate: the project's "Fix CI while I'm away" toggle (below); counts against
  six wakes per tab per local day; only live tabs (closed or exited → the
  watch drops); one notice outstanding per tab.
- Headless/Mobile host: watches work only in a window-run lane (like writes):
  `window_required` otherwise. Phase 2 with the headless plan.

Frontend: the toggle (pill menu + git bar chip with expiry), and the watch shows as a small row on the tab's git-lane card list
("Watching CI run #N", Cancel); strings in all languages; untested id
`gitPushMcp.ciWatch`. Settings: nothing new — it rides the schedule switch and
level.

Tests: argument/gate refusals; newest-run resolution; poller completion →
exactly one queued NOTICE with no CI text; budget exhaustion; dead tab drops
the watch; expiry; repo_changed.

Commit 6: `feat(git-lane): ci_watch wakes the tab when a CI run finishes`.

Gate (proposed by the user, 2026-11-19): a per-project **"Fix CI while I'm
away"** toggle instead of tying `ci_watch` to the schedule lane.
- Off by default; on the project pill menu and the git bar, showing a visible
  "CI autopilot on" chip while on. Stored in the trusted `projects.json` entry
  (never the in-folder project.json, not carried in project bundles).
- Expires by itself: the user picks "until 08:00" / "for 12 h" when turning it
  on; expiry or turning it off drops all watches and pending notices.
- While on, for that project's agent tabs only:
  - `ci_watch` works and its fixed NOTICE is delivered without a card (idle
    gate, one outstanding per tab), whatever the schedule level;
  - `git_push` to a non-default, non-protected branch runs as Apply even if the
    project level is Propose. `main`/default/protected/workflow-named branches,
    releases and PR merges still always card — nothing ships overnight.
  - `pr_create` follows the PR rules (into main → card), so the morning starts
    with a card to review.
- While off, `ci_watch` answers `autopilot_off` naming the toggle (like
  `level_off`), so the agent can tell the user where to turn it on.
- Budgets still hold: watches ≤ 2 per tab, wakes ≤ 6 per tab per local day,
  pushes 6/h.
- Morning summary: the git-lane card list shows what happened while it was on
  (pushes with commits, runs watched, wakes) so the review is one place.

Later, separately: `ci_rerun_failed { run }` (only while the toggle is on, own
small budget) for flaky jobs. Not in this plan.

## Decisions (user, 2026-11-19)
1. pr_create: card only in the risky cases (default/main/master/protected base,
   CI-only repo, mentions / cross-repo refs / slash lines); Apply opens
   feature-branch PRs directly.
2. pr_comment at Apply: direct only on same-repo PRs by the token's user; fork or
   other people's PRs show a card.
3. Writes allowed in the confirmed push repo and in CI-allowed repos, the latter
   always carded; "Allow CI" also covers PR reads.
4. Separate 10/h PR-write budget per tab; PR cards share the two-pending limit.
5. Leak check: token shapes only (secret_in_text).
6. Comment card goes stale when the PR head moves.
7. draft defaults to false.
8. Caps: title 256, body 20 000, comment 8 000.
9. `ci_watch` is gated by a per-project, self-expiring "Fix CI while I'm away"
   toggle (section 11), not by the schedule lane.
10. Build order: PR tools (commits 1–5), then `ci_watch` and the toggle
    (commit 6); `ci_rerun_failed` later.
