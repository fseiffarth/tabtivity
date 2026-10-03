# Sharing on the hosted server: projects through a hub, calendars through a service

*Design rationale for hosted plan P4 (`docs/tabtivity_hosted_plan.md` §6.2–§6.7,
§4.3/§4.4), as built on branch `hosted`. Nothing here has run on a real server;
the live steps are in `docs/hosted_handoff.md` § P4. The gateway, daemons and
helper this builds on: [`server_gateway.md`](server_gateway.md).*

## Shape

```
user's daemon (uid A) ─┐                          ┌─ /srv/<slug>/shared/<id>.git  (0700 <slug>-hub,
user's daemon (uid B) ─┼─► /run/<slug>/hub.sock ──┤   user:A:r-x, user:B:r-x + default ACL)
                       │   <slug>-hub (SO_PEERCRED)└─ /var/lib/<slug>-hub/shares.json, audit.jsonl
                       │
                       └─► /run/<slug>/calendar.sock ─► <slug>-calendar as <slug>-cal
                                                       /var/lib/<slug>-calendar/<id>.json (0600)
reads of a hub: by path, as the user (named ACL), `-c safe.directory=<that hub>`
```

**Authorization stays "only by uid" (§4.3).** No request of one user ever
reaches another user's daemon. Both services are separate system accounts on
root-owned `0666` sockets in `/run/<slug>` (nobody squats them; fences hide
`/run`), classify every caller by `SO_PEERCRED` with the admin helper's own
account rule, and keep their own tables. Requests name share or calendar ids,
never paths.

## Projects: a bare hub, a clone per member

- **The owner's project never moves.** `share_create` asks the hub for an empty
  bare repo (`git init --bare --template=` — no hooks, no `info/`, no samples),
  adds it as the `shared` remote, excludes the app's folder in
  `.git/info/exclude` and pushes the checked-out branch.
- **Read access is a named-user ACL**, never a group: `r-X` on the whole hub
  plus every directory's default ACL (new objects inherit it), nothing for
  group or other, the shared root `0711` (passable, not listable). A grant or
  revoke takes effect at the next path lookup; a revoke takes the entry off the
  top first, then off every entry (an fd opened below the top before the revoke
  loses it too as the walk passes). ACLs are written straight to the
  `system.posix_acl_*` xattrs (`src-gateway/src/acl.rs`): no `setfacl`, no
  libacl. The owner of a file may set its ACL with no capability, so the hub
  needs none.
- **Nobody but the hub writes a hub.** Plan §6.2 had `config`/`hooks/`/`info/`
  root-owned; the hub must create hubs at run time without root, so instead
  every hub belongs to `<slug>-hub`, which no member can act as, and members
  get `r-X` only. That is the property §6.2 step 5 needs to make
  `safe.directory` safe. The hub runs no hook (`core.hooksPath=/dev/null` on
  every call, and nothing ever runs `receive-pack`).
- **Pushes are bundles.** The daemon fetches the hub, bundles what the hub
  lacks (`HEAD --not --remotes=shared`), sends the request line and then the
  bundle bytes. The hub checks the role and ref rules **before reading a byte**
  (a viewer never uploads), then `bundle verify`, `bundle unbundle` (objects
  only, no ref), a compare-and-swap on every old value, a fast-forward check
  unless forced, and one `update-ref --stdin` transaction. Rules
  (`hub_wire::ref_allowed`): the owner moves anything; an editor
  `refs/heads/<own name>/*`; a viewer nothing. No pkt-line parsing, no
  member-run git against a writable repo (§6.2 step 3). Garbage from refused
  pushes stays until a gc (#2372).
- **`safe.directory`, the exact scope (a test pins it):** git refuses to
  *open* a repository another uid owns — a local-path clone does — unless
  `safe.directory` names that exact path; the transport (`clone --no-local`,
  `fetch`), which runs `upload-pack` against it, does not check (git 2.53).
  Tabtivity uses the transport (it also never hardlinks another uid's object
  files) and pins the exact hub on every call anyway, never `*`.
- **Clone-to-add** goes through the ordinary import (`find_project_conflict`,
  untrusted `project.json` fields stripped); from then on it is the member's
  own project, tabs, trust and agent homes. **Session files never reach a
  commit:** the app's folder is excluded in the owner's repo and every clone,
  and a push whose new commits carry it is refused.
- **The fence** mounts a tmpfs over `/srv/<slug>/shared` and binds back,
  read-only, only the hub of the scope's own project (`share::fence_args`, both
  fence wraps), so a co-member of X cannot steer this user's agent into
  reading Y.
- **Revoke and delete** never touch the member's copy: their map
  (`<state>/shares.json`) turns the link `revoked` or `deleted` and the panel
  greys the row (the pill does not yet, #2373). Delete moves the hub to
  `.deleted/` for 30 days; `user-remove` asks the hub (root-only `forget`) to
  take the account off every share, so its ACL entries go with its
  membership. A revoke whose ACL walk fails half-way keeps the account in
  the share's `revoking` list (off the table, so no push) and is retried at
  every hub request until the walk completes. A `shares.json` that exists
  but cannot be parsed is never replaced: every change is refused instead.
- **Remote, VM and container projects are refused** (one human assumed by
  lockstep, byte-sync, worker sync).
- The admin's **`project_sharing`** switch (new in `policy.json`) stops new
  shares and new members; existing ones keep working (§6.7's rule).

## Editor shares: the gates of §6.5

1. **Hooks and config.** In any project in the user's share map (the owner's
   own or a clone), `commands::git::git_command_in` downgrades a hooked verb to
   hookless and `require_hook_trust` asks nothing (hooks can arrive by merge),
   and config sanitizing **fails closed**: after the strip every config file is
   listed again; a surviving denylisted key, or a file git cannot parse,
   replaces the git call by one that runs nothing and says why.
2. **The agent-facing surface is reviewed before an agent reads it.**
   `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.mcp.json`, `.envrc` at any depth and
   everything under `.claude/`, `.codex/`, `.gemini/`, `.cursor/` (the plan's
   list), plus the project files of every other CLI Tabtivity launches
   (`CLAUDE.local.md`, `AGENTS.override.md`, `.agents/`, `.agent/`, `.kiro/`,
   `.clinerules`, `.vibe/`, `.opencode/`, `opencode.json(c)`, `.factory/`,
   `.cursorrules`, Copilot's `.github/` instructions and agents;
   `share::AGENT_PATHSPEC`). The rule is
   on commits, not on files: an agent-facing change is *unreviewed* when it is
   in HEAD, came from the hub (reachable from `refs/remotes/shared/*`) and is
   not behind a commit this user marked reviewed (the owner's HEAD at sharing,
   a merge made after its review, an accepted review, each of their own
   pushes). So it catches every way in — a fresh clone, a merge through the
   app, a `git merge` in a terminal — and none of the user's own edits.
   "Came from the hub" survives the hub branch going away: the app's fetch
   keeps every tip it moves away under `refs/shared-seen/<oid>` (dropping
   those a branch still reaches), the check also reads the tracking refs'
   reflogs (a terminal `git fetch`), and a merge commit's own change is
   read with `diff-tree -c` (an "evil" merge). Residual: a `git pull` or
   `git fetch` *by path* in a terminal, followed by the branch's deletion
   before any app fetch, leaves no trace. **Stop sharing** keeps the
   owner's link (as `deleted`) while such changes are unreviewed, so the
   gate holds; reviewing them lets it go, and a new share is refused until
   then. A share that is gone still shows its project's review. While
   anything is unreviewed, **every agent start in the project is refused**
   (fenced or in a container, failing closed when the check cannot run) and so
   is a push (a push would mark it reviewed). A merge through the app shows the
   diff first and runs only with that review's digest; a conflict is aborted.
   Per-author trust (Q9) is #2371.
3. **`exec_trust` never crosses users** (each daemon's own state dir) and is
   bound to content, so a merged `latexmkrc` or prettier config asks again; a
   test pins both.

No container gate, as §6.5 argues: each member works in a private clone under
a separate uid and the fence confines agents per scope.

## In-tree worktrees of a shared project (P5)

A member's clone is their own repository, so worktrees in it
(`<root>/.tabtivity/worktrees/<name>`, the desktop's one sanctioned place)
are written by that member's uid alone — no cross-user tree, and none of
pair mode's hazards. What the gates needed:

- **Gate 2 reads every checkout.** `share::checked_out` lists the main
  checkout and each linked worktree (`git worktree list --porcelain`), and
  `unreviewed` walks from all their commits: an agent can start in any of
  them (a tab's cwd is a worktree; `roots` are the project's), so a
  co-member's agent file merged into one worktree refuses every agent start
  in the project until it is reviewed. The review shows the files as each
  checkout holds them, labelled with the worktree, and accepting it marks
  every checked-out commit.
- **Gate 1 already held**: `is_shared_dir` is a prefix test on the project
  root, so a worktree under it runs hookless with strict config, and
  `repo_config_files` reads a worktree's own `config.worktree` and its
  common dir's config.
- **Not built**: pushing a worktree's branch through the app (the Push
  button pushes the main checkout's branch; a terminal `git push` to the hub
  is impossible anyway) and merging into a worktree through the app.

## Pair mode (P5): designed, not built — needs the user

Pair mode is "one shared tree, for people who accept the hazards". Every
design of it breaks one of P4's premises — *each member's `.git` is theirs
alone* — and therefore needs a decision before it is built (#2382):

- **With a shared `.git`** (one repo both uids write): hooks and the
  denylisted config keys are already off (gate 1 fails closed), but P4
  review finding 11 is exactly here: git's other program-naming keys
  (`merge.<driver>.driver`, `diff.<driver>.textconv`, `core.sshCommand`,
  `gpg.program`, `remote.*.uploadpack`, `filter` drivers on paths a member's
  `.gitattributes` names…) would let one member's config edit run code as
  the other. That is cross-user code execution unless every such key is
  refused (#2374's decision), and new git releases add keys.
- **Without a `.git` in the tree** (the shape this agent would build): the
  hub makes `/srv/<slug>/pair/<id>/` with named-user `rwX` ACLs (default
  ACLs on every directory) for its members, refuses and never opens a `.git`
  there, and each member commits from their **own** clone by copying or
  syncing the tree in (`git --work-tree=<pair tree>` from their private
  git dir). The fence binds the pair tree read-write into its own scope only
  (a tmpfs over `/srv/<slug>/pair`, as for hubs). No in-tree session files
  are written there (two uids would fight over them). Gate 2 cannot be on
  commits — a member edits `CLAUDE.md` live — so it becomes a **content
  gate**: a digest of the agent-facing files as this user last reviewed
  them; any difference refuses agent starts until reviewed (own edits
  included: nothing tells whose write it was, since a write into another's
  file keeps its owner). `exec_trust` stays per user and content-bound.
- **Hazards that stay, whichever shape**: a member can delete or rewrite
  anything in the tree (no history there between commits); an agent of one
  member edits files the other is editing (no locking, no CRDT — §13);
  a build script one member writes runs as the other when they press Run
  (exec trust asks, per content, but the trust prompt is the only gate).

## Calendars and to-do lists: a service, a move

- **Sharing is a move.** A calendar shared for the first time leaves the
  owner's `calendar.json` (one transaction) and enters `<slug>-calendar` with
  its events, tasks and board columns; if the service refuses, it is put back.
  `unshare` hands everything back under the calendar's own id. The default
  calendar, CalDAV calendars and read-only subscriptions are refused.
- **Roles per part:** the owner opens a calendar's events, its to-do list, or
  both, to named users as viewer or editor. The exit of P4c is a pair of
  grants: B events-viewer, C tasks-editor.
- **The merged view.** `calendar_load` appends what the user may see as
  `shared:<id>` calendars (read-only when they may edit no part); the edits of
  such records go to the service with the record's `rev` (compare-and-swap); a
  record never moves between a shared and a private calendar; a whole-document
  save strips them. The browser's `SharedCalendarWatch` long-polls
  `shared_calendar_wait` (the service's change counter, plus a one-second
  re-read of the store) and reloads the store, so another member's edit shows
  within one change.
- **What never crosses:** a task's mail link, file link, the appointment it
  came from and its project, an event's CalDAV address — stripped by the
  service on every way in (`cal_wire::clean_record`), whatever a daemon sends.
  The **owner** keeps them: her daemon stores them by task id
  (`<state>/shared-calendars.json`), lays them back on her own cards and on
  unshare. Text is bounded per field, records per calendar. Rendered as text
  by React; no HTML.
- **Alarms are per viewer:** reminder state (fired, snoozed, dismissed) is each
  daemon's own record; the service holds definitions only. Headless (no-window)
  reminders do not see shared calendars yet (#2369).
- **Bounded so it always comes back:** a stored calendar is at most 12 MB
  (`cal_wire::MAX_CALENDAR_BYTES`, under the 16 MB answer line), so `get`
  and `unshare` always fit; `unshare` moves the file to the service's own
  `returned/` for 30 days rather than deleting it, and a daemon that cannot
  write the answer into `calendar.json` keeps it in
  `<state>/shared-calendars-returned/<id>.json` and says so.
- **One wait per daemon:** the browser's pages share a single long poll at
  the service (six connections per account, 64 overall), so open pages never
  starve their user's own edits or other users.
- **Agents read nothing and write nothing there:** the fence hides the
  socket; the agent-facing calendar paths read and write `calendar.json` only
  (on a server they do not run at all yet, #2339); a proposal naming a
  `shared:` calendar is refused.
- **Switches:** with `calendar_sharing` off the service opens nothing new and
  hides incoming calendars (owners keep theirs); with `calendar` or `todo` off
  that part is closed for everyone; data stays.
- **Storage deviation:** one `0600` JSON file per calendar, written atomically
  under a per-calendar lock, instead of the plan's SQLite — the same shape at
  this scale, no new dependency in the gateway crate.

## The gateway is not in the loop (deviation)

§6.2/§6.4/§6.6 put share rows, ref rules and the presence fan-out in the
gateway database. The hub and the calendar service are the only processes
that apply those rules, so the tables live with them, as the key keeper's
lists do (P3b decisions); the gateway still links no core service and holds
no share state. Audit rows (no names, titles or paths) are in each service's
own `audit.jsonl`.
