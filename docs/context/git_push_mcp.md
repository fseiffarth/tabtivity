# Agent git push MCP

Desktop v1: a fenced agent tab can ask
Tabtivity to push the project it works in, without a credential ever entering the
fence. Globally **on** by default since 2026-09-26 (`Settings::git_push_mcp`,
absent = on, `false` = off; Settings → Manage CLIs) — the fence has to stay
usable, and the default level only proposes. When on, every new local
project-agent spawn (not a container tab; not
a remote, VM or container project) gets the `tabtivity-git` server on `/mcp/git`
with a `Caller::Pusher` token bound to the tab, the project and the trusted
entry's canonical directory. The per-project level lives in the `projects.json`
entry's `git_push_mcp` block (`level` off / propose / apply, `protected`,
`confirmed_url`), default **propose** (absent = propose, so every agent push
or release is a card the user clicks), also on the project pill menu. An `off`
project still gets the tools: every write answers `level_off` naming the
setting, so the agent can tell the user where to turn it on.

Tools: `git_push_status` (read-only), `git_push { branch?, note? }`,
`git_push_cancel { id }`, `git_release { tag?, note? }` (below), and the
read-only CI reads `ci_runs`, `ci_run`, `ci_security_alerts` (below). No
remote, URL, refspec or force selector
exists. Every failure is a normal tool result with a fixed `category`, one
`message` saying what to do next, capped and redacted `output`, and `state`.

## Why two phases

`commands::git::git_push` runs the repo's `pre-push` on the host with
`TABTIVITY_GIT_TOKEN` in the environment after `exec_trust` approved the hook
*files*; what those files run is not fingerprinted (this repo's hook runs
`scripts/privacy-check.sh` and `scripts/bump-version.sh`, both agent-writable).
Fine for a user's click, a fence escape once the agent can trigger the push.
So an agent push never runs project code on the host, and no process that
runs project code holds the token:

1. **Preflight, fenced, no token.** `resolve_pre_push_hook` finds the hook the
   way `exec_trust` does (`rev-parse --git-path hooks`). It runs with git's
   arguments (`<remote> <url>`) and stdin line, `TABTIVITY_PUSH_PREFLIGHT=1`, the
   token variables removed, inside `agent_fence::one_shot_command` for the
   fence scope recorded on the tab's push identity
   (`PushBinding::fence_scope`, copied into the proposal) — a *narrower*
   bubblewrap profile built from the same primitives (project/box roots,
   allowlist, git-control guard, credential and state masks), none of the
   tab's agent-home or launcher mounts. The token is minted in
   `launch_prep::prepare` before the fence is decided, so the spawn path
   stamps the scope onto the binding (`TokenStore::stamp_push_fence_scope`)
   once the decision is `Fenced` and the wrap succeeded, before the agent
   process exists. **No recorded scope, no hook run** (gap 18): the hook is
   agent-writable, so a missing scope is `fence_unavailable`, never a host
   fallback (the host branch exists only in the hook tests). A Pusher exists
   only for a local project agent, which is always fenced on Linux and macOS,
   and the root console's unfenced Host session gets no Pusher. A fence that
   cannot run fails closed too (`fence_unavailable`). Linux only: on macOS
   the one-shot fence is not built, so a repo with a hook gets
   `fence_unavailable`; on Windows (no fence) it gets `fence_unavailable`
   with "push from the git bar". A repo without a hook pushes on every
   platform. The scope used to come from the fence registry
   (`fenced_scope_of_tab`), which a stale `pty_kill` could clear after a
   pane remount — then the hook ran unfenced. Exit ≠ 0 refuses with
   the hook's output; five minutes is the cap. Commits the hook adds are
   picked up: the plan's SHA, commit list and diffstat are re-read, and the
   hook runs once more on the new tip, so its stdin line always names the SHA
   that is pushed (a scan then covers every commit that leaves); a hook that
   adds commits on that second run too is `preflight_failed`.
2. **Transport, host, hooks off.** `push_transport_command`:
   `hardened_git_command_in` (pins `core.hooksPath=`, so
   `reference-transaction` is off too) with the scoped inline credential
   helper for `token_origins(project)`, `GIT_TERMINAL_PROMPT=0`, `--no-verify`,
   the URL positional and the one refspec `<sha>:refs/heads/B` — the SHA the
   plan validated (Apply) or the approved card showed (Propose), never the
   branch by name: `.git` refs stay writable in the fence, so the agent could
   move the branch between the approval and the transport (gap 10, #2344).
   The lane's own git reads (`lane_git_command`: plan, commit list,
   `merge-base`), the hook and the transport set `GIT_NO_REPLACE_OBJECTS=1`:
   a `refs/replace` graft (writable in the fence) would otherwise hide a
   commit from the card and the scan while `pack-objects` still sends it, or
   pass push's fast-forward check for a rewrite of the remote branch.

`.githooks/pre-push` knows the variable: under it the signing reminder (gh +
network) is skipped, the privacy scan and bump commit run as before, and it
exits 0 instead of re-pushing and aborting. Without it nothing changed.

## What may be pushed

Decided on the host from the hardened git's view and `projects.json`; nothing
from the in-folder `project.json`. The checked-out branch only (`branch` must
name it), with a same-named upstream (`branch.B.remote` / `.merge`). Never the
remote's default branch — `ls-remote --symref HEAD`, falling back to
`refs/remotes/<r>/HEAD` then `main`/`master` — nor a listed `protected` one.
The remote branch must exist; the push is fast-forward only (`merge-base
--is-ancestor` against the `ls-remote` SHA, `diverged` otherwise, never
retried). No tags, no deletes, no `+`. The URL is the raw `remote.<r>.url`,
passed positionally so `pushurl` plays no part; because a repo-scope
`url.*.insteadOf` / `pushInsteadOf` would still rewrite a positional URL, its
presence refuses (`url_rewritten`). The first push to a URL stages for the
user's confirmation whatever the level, and pressing Push records it as
`confirmed_url`; a changed URL asks again. An https URL without a stored token
is `auth_failed` up front.

## Levels, budget, proposals

`admit` validates arguments and takes the budget before any git runs: six
`git_push` calls per tab per rolling hour (`Session::admit_push_rate`), at most
two pending/running requests per tab. A `git_push` creates a proposal record
and runs plan → preflight → stage-or-push on a worker under a per-project lock;
the call waits up to 18 s (the listener's sockets live 30 s) and otherwise
answers `running` with the id. **propose** stages after the preflight, so the
card shows the *final* commit list, bump included; **apply** pushes at once.
Approval binds the post-preflight SHA: a branch moved before the click is
`stale_approval` (the card no longer describes it, so the user decides
again); one moved after the check changes nothing, because the transport
pushes that SHA itself. A moved remote is re-checked for fast-forward. Unapproved proposals expire after
24 h; records live 24 h in memory beside the tokens (neither survives a
restart) and go with a revoked session. Dismissing a *finished* card
(`git_push_mcp_clear`) only sets `cleared`: the card hides it, while
`git_push_status` still reports the outcome to the agent. There is no typed notice into the
tab — the schedule lane types *prompts*, and a push outcome must not become one
— so a `staged`/`running` result tells the agent to poll `git_push_status`.
The audit ring keeps the session, tool and category; never the note or output.

Output hygiene: last 8 KB, invisible controls stripped
(`root_mcp_mail::strip_invisible`), the effective token, `ghp_`/`github_pat_`/
`glpat-`-shaped tokens and URL userinfo replaced by `[redacted]`. <!-- privacy-check: ok — names token prefixes, holds none -->

## Wiring

Copied from the schedule lane: `Caller::Pusher`, route `/mcp/git` checked
before the body read (`path_serves`), its own branch in `commands::root_mcp::
handle`, tools known only to `git_push_mcp` (the root registry never serves
the class; tests hold that). `root_mcp::lane` gives every class its lane, so
the schedule, push and help tokens coexist on one tab and a respawn replaces
only its own. Spawn: `apply_git_push_to_spawn` after the schedule wiring,
Claude `--mcp-config`, Codex `-c mcp_servers.tabtivity-git…`, tool-tagged Vibe
merged into `VIBE_MCP_SERVERS`, other CLIs the inert `TABTIVITY_GIT_MCP_TOKEN` /
`_URL` pair. `SpawnTokenGuard`, the PTY exit path, `tmux_local::SECRET_ENV` and
`sandbox::is_secret_exec_env` know the new variable. Sessions appear in MCP
session access with Revoke (which drops the session's proposals). State
changes ring `git-push-mcp-changed` through a change hook the command layer
installs, so the service stays `AppHandle`-free.

Frontend (`components/agents/GitPushMcp.tsx`): switch + per-project level and
protected list in Manage CLIs, pill-menu level (apply asks first), the card in
the git bar (`ProjectFilesView`) and the Agents view. Everything carries the
`gitPushMcp` untested id.

## Known limits

- **The token is inherited** by every process in the tab, as with schedule
  and root (`docs/context/root_console.md`). Hence propose by default and
  fixed rules even at apply.
- **The preflight can lie**: it runs agent-writable code with the agent's own
  authority, so a hook's privacy scan is only as strong as the fence. Inside
  the fence `$HOME` is empty, so this repo's per-user
  `~/.config/tabtivity/privacy-denylist` is not seen there (the per-clone
  `.git/info/privacy-denylist` is). CI's privacy job is the backstop. What the
  lie cannot do is touch the token or the host.
- Hooks other than `pre-push` do not run for agent pushes. Global
  `insteadOf` rewrites are the user's own and apply as they do to the Push
  button.
- **Tabs the Mobile host started with no window** (`docs/headless_mcp_plan.md`)
  get the lane from the host's own listener, which never reads the keychain
  (`git_push_mcp::serve_without_keyring`): `git_push` / `git_release` answer
  `window_required` (after argument checks, costing no budget), CI reads go
  without the token, and a private repo's `not_available` says why. Queuing
  those requests for the window's card is phase 2 of that plan.
- Out of v1: phone approval cards, remote/mirror projects, creating remote
  branches, other forges' token quirks, a typed outcome notice.

## Releases (`services::git_release`)

The git bar's **Release** button (shown when a local project's own repo has
a remote, nothing unpushed and nothing incoming) and the agent's
`git_release` share one path: tag the checked-out branch's tip, annotated and
never signed (`-c tag.gpgSign=false`, so a repo `gpg.program` cannot run), and
push the one refspec `<tag object>:refs/tags/T` through the hooks-off
transport — the local tag's object read once and checked to peel to the
tip (`stale_approval` otherwise), so a tag re-pointed before the transport
is not what leaves. Refused unless the tip is exactly the remote branch's SHA
(`not_pushed`) — a tag can never publish commits the branch push (and its
privacy scan) did not — and unless `T` is new on the remote (`tag_exists`;
never moved). On a github.com remote the tip's CI must also have passed
(`git_ci::tip_ci`): the latest run of each workflow the branch push started
on that commit; any still queued/running → `ci_pending`, any finished
without passing → `ci_failed`. No runs (no CI for that branch) passes, and
CI that can't be read (no access, offline) doesn't gate — this repo's
`release.yml` re-checks server-side and deletes a tag whose CI failed. A local tag already on the tip is reused; one this call made is
deleted again when the push fails. The suggested name is `v<version>` from
the first of `package.json`, `src-tauri/tauri.conf.json`, `tauri.conf.json`,
`Cargo.toml`, `pyproject.toml` at the tip, unless that tag already names
another commit (version not bumped), else the latest `v*` tag counted up. The
button runs behind `exec_trust` like Push (with no stored token the user's
own credential helpers answer); the agent path needs a stored token for https
and is **always staged**, whatever the level: approval re-plans against the
live remote and binds the proposed tip (`stale_approval` if it moved). The
button skips the `pre-push` hook (this repo's only guards branch pushes and
the signing reminder; the release job refuses unsigned anyway).

## CI reads (`services::git_ci`)

`ci_runs { ref?, limit?, failedOnly? }`, `ci_run { id }` and
`ci_security_alerts { ref?, limit? }` let a fenced agent read why the build,
the tests or the security workflow failed. Tabtivity calls api.github.com from
the host; the repo is the checked-out branch's upstream URL (else `origin`),
github.com only (`not_github`), never an argument. The token goes to the API
only when `https://github.com` is one of the project's token origins. `ci_run`
returns jobs and steps and, for up to three failed jobs, check annotations and
a log excerpt (120 lines before the first `##[error]` to 20 after the last;
timestamps and ANSI stripped; 12 KB; redacted). Job logs are fetched through
GitHub's redirect without the token, at most 32 MB read, the last 4 MB kept.
Budget: 60 reads per tab per hour (`git_ci::admit_rate`). Nothing writes — no
re-run, cancel or dispatch. Reads work at every level, `off` included.

## User-run live QA

Only after choosing to load a build with the backend; agents never restart
the app.

1. Settings → Manage CLIs: turn on agent pushes. Set this project to Propose
   (pill menu or the row). Open a fresh fenced Claude tab.
2. Commit something trivial and ask the agent to push. The git bar shows a
   card asking to confirm the URL; its commit list should include the bump
   commit. Press "Confirm URL and push"; check GitHub, and that the agent's
   `git_push_status` reports `pushed`.
3. Ask it to push `main`: expect `branch_protected`. Ask for a force-push or
   a tag: the tool cannot express either.
4. Make `scripts/privacy-check.sh` exit 1: expect `preflight_failed` with its
   output on the card and in the tool result, nothing pushed. Restore it.
5. Set Apply: a push lands without a card (the URL is confirmed by now).
   Revoke the session in MCP session access: further calls fail, the tab
   stays open, its card disappears.
6. Repeat step 2 in Codex. On Windows (no fence), a repo with a `pre-push`
   hook answers `fence_unavailable` ("push from the git bar").
7. Fresh settings (no `git_push_mcp` key): a new agent tab has the tools and
   a project with no block reads Propose on the pill menu.
8. Release button: with everything pushed, press Release; the dialog
   suggests `v<package.json version>`. Tag & push; check the tag on GitHub
   is annotated on the right commit. Press it again with the same name:
   `tag_exists`. Commit without pushing: the button hides.
9. Ask the agent to `git_release`: a Release card appears; press Release.
10. Ask the agent why the last CI run failed: `ci_runs { failedOnly: true }`
    then `ci_run { id }` should quote the failing step's log and annotations.
    `ci_security_alerts` lists open CodeQL alerts (or says it is not set up).
