# Root console

The root scope is Tabtivity's cross-project working surface. It is where you
manage everything that sits above a single project: the calendar, the to-do
board and the project list itself. This doc covers two design choices: why the
root scope is an overlay, and why its agents have rights no other agent has.

## An overlay, not a scope to switch to

The root terminal used to be a scope like a project, so opening it replaced the
project on screen. The one terminal that belongs to no project was also the
only one that cost you the project you were working in. Now Ctrl+Shift+R, the
scope chip's Root entry and every "log in in the root terminal" flow open
`RootOverlay`: one subwindow that floats over whatever is open.

The scope itself is unchanged. Its tabs still live in `tabsByScope.root` and
persist under `sessions/root/`. Their PTYs are still owned by `CenterPanel`'s
keep-alive pane layer, and the overlay's panes are attach-only views of them.
This is the same arrangement popouts use, so closing the overlay ends nothing.

It is the only overlay onto the root terminal. One-click installs
(`runInstallInTab`) used to float a second one, `InstallOverlay`: a single
attach-only terminal on the install's root tab. That made two dialogs over one
scope, and the smaller one could show only the tab it was opened for. An install
now opens its tab in the console through `openTabInRootConsole`, the same door
a parked login (`openConnectionInRoot`) takes. That door restores the root
scope *before* adding the tab. A tab added to a root never opened this session
creates the scope key, which reads as "hydrated", so the restore would be
skipped and the host's persist would write the lone new tab over the saved root
layout.

The overlay renders the root layout as stored, splits included. Dragging a tab
onto another subwindow's strip or a body's edge rearranges it as in a project,
through the tab store's `…InScope` actions. The ordinary layout actions only
write the *active* scope, and root is not the active one while the overlay
floats over a project. The drag keeps its state local rather than in
`stores/drag/drag`, because that store puts `CenterPanel` into drag mode underneath.

It is a window, not a dialog, so it behaves like one. The title bar is the move
handle (a press on a tab or a control keeps its own meaning), eight grips on the
edges and corners resize it, and ⤢ fills the window — as does a double-click on
the bar. The frame lives in `stores/rootOverlay`, in localStorage rather than
`settings.json`: where a window sits on one desk is not a preference worth
syncing. It is re-clamped against the window it actually opens in, so a console
sized on an external display is still reachable on the laptop panel, and an edge
dragged past the minimum pins the opposite edge instead of pushing the console
across the screen. An untouched console keeps the size the stylesheet gives it.

Every subwindow also docks the **file viewer** on its right edge, through the
same ◫ a project's subwindows carry — the shared `SubwindowFilesSidebar`, i.e.
the `ProjectFilesView` the side panel and the Files (Project) tab render, so
there is no fourth copy of the viewer. It is rooted at `~/tabtivity/root`, the
folder that belongs to no project: the console had a terminal on it and no way
to see what was in it but `ls`. The state is the group node's own
(`filesOpen`/`filesWidth`/`filesFolder`), so it persists with the root layout
under `sessions/root/` — but it is written through `setGroupFiles*InScope`,
because root is not the active scope while the console floats and the plain
actions would have filed the console's file column onto the project on screen.
Unsplit, the ◫ sits in the console's title bar and the control cluster reserves
the column's width the way `TabBar` does; split, each subwindow carries its own.

The console's "+" is `NewTabMenu`, the popout's menu — and its **Monitoring**
group is the whole of it: System Monitor, Disk Usage and Network Traffic. The
first two ask about this machine and always did; Network Traffic was withheld
from root as "per-project", but only its *remote* half is a project's. Without
one, `NetworkTrafficPane` renders what a **local** project's tab renders — this
machine's interfaces, rates and sockets — and drops the host/link switch, the
SSH-link totals and the files-synced totals, which have nothing to answer for.
The backend needs no root case: an id no project carries is an id
`remote::remote_target_for` finds no host for, which is already the local read.
Only `get_net_usage` is skipped outright, because its empty id means *every*
project's link usage (the recap's reading), not "no project".

The console's "+" also keeps `TabBar`'s ensure bargain, which it could not
inherit: `NewTabMenu` hands back a resolved payload and no hint of which handler
built it, where `TabBar` spells the rule out one `ensureTab` call at a time. So
`addTab` reads it off the kind (`isSingletonTabKind` — the monitor, the print
queues, the skills catalog, the prompt chart, the calendar, the 3D cloud) and
focuses the tab that exists instead of stacking a copy. It focuses through
`revealTabInScope`, not `setActive`: root is not the active scope while the
console floats, and the boolean says whether it landed. A false means the tab is
somewhere this console cannot show it — a parked or detached subwindow — and the
console opens its own rather than leaving the button doing nothing. A popout's
copy of the menu gets none of this: the tab it would focus may live in another
window entirely, where focusing it is not an answer.

The console hosts **every viewer a project has** — PDF, Markdown, TeX
workspace, tables, notebooks, diffs, Files tabs — because they are the same
`TabPane`s. What kept them from working was scope, twice over:

- **Opening.** The open-a-file paths (`openFileEntry`, `openTexWorkspace`, the
  tree's diff and compiled-PDF openers, `openProjectFilesTab`) called `addTab`,
  which writes the *active* scope: a PDF double-clicked in the console's file
  column appeared in the project underneath. The console now provides
  `TabScopeContext` = root and those paths open through `openTabInScope`,
  deduping against root's own tabs. A link followed from a viewer
  (`openLinkedFile`) needs no context: it opens in its linking tab's scope.
  This is deliberately not `FileDropContext`, the popout seam — providing that
  would take file *drags* away from `CenterPanel`'s drop authority.
- **Writing back.** `setViewerState`, `setTabViewer`, `setTabFolder`,
  `setTabUrl`, `setTabLocation`, `updateTabEnv`, `renameTab`, `setTabColor`,
  `setActive` and `removeTab` are addressed by key but only searched the active
  scope, so a console viewer's zoom or a Files tab's folder was a silent no-op.
  They now resolve the scope that owns the key (`scopeOfTab`; keys are unique
  store-wide), and viewers read their tab through `findTabByKey`.

The console's "+" also offers the 3D project cloud, the one root-only view
`TabBar` had and `NewTabMenu` lacked.

Two jobs moved into the overlay's always-mounted host because root no longer
becomes the active scope:

- **Persisting root.** `CenterPanel` saves only the active scope.
- **Hydrating root.** Restoring root on first use used to happen on a scope
  switch.

With no project open, `CenterPanel` still shows the root scope. While the
overlay is up, the panel's copies of the root panes stand down: two visible
views of one PTY would take turns resizing it.

## The extra rights

A root agent is asked for things that are not any project's business: "add a
calendar entry on Friday at 14:00 for an hour", "put a card on the board for
project X". Those stores are Tabtivity's own, so Tabtivity serves them as MCP tools
(`services::root_mcp`) over loopback HTTP (`POST /mcp`, one JSON-RPC message in
and one reply out).

**The boundary is a bearer token per root-agent spawn.**

- **Minted per spawn and never written to disk.** A fenced project agent sees `/`
  read-only, so a token in a file would be a token it can read. What does reach
  disk is a one-way hash: proposals carry `mcp_session = sha256(token)` as the
  spawn's id, and drafts, sandbox copies and the mail-taint marker are keyed by
  `sha256(tab)`, the stable per-tab id — neither can be turned back into a token.
- **Handed out in one place.** `pty_spawn` calls
  `root_mcp::apply_to_spawn` only when `is_agent && project_id.is_none()`.
  `project_id` is the same trusted spawn input that picks the fence roots, and
  an agent cannot make Tauri calls, so it cannot ask for a root spawn.
- **Given on the CLI's own command line, never through its config files.**
  Tabtivity does not write another application's config, and a flag dies with the
  tab. Claude gets an inline `--mcp-config` whose header reads
  `Bearer ${TABTIVITY_ROOT_MCP_TOKEN}`, which Claude expands from its environment.
  Codex gets `-c mcp_servers.tabtivity.url=…` plus `bearer_token_env_var`. Vibe
  (a local-model tab) gets `VIBE_MCP_SERVERS` (naming the token via
  `api_key_env`) and `VIBE_ENABLED_TOOLS=["tabtivity_*"]` — its env layer outranks
  the per-model `config.toml` that turns tools off — but only when the model
  wears the Models & agents menu's opt-in "MCP" chip
  (`settings.ollama_mcp_models`). Every other agent gets `TABTIVITY_ROOT_MCP_URL`
  and `TABTIVITY_ROOT_MCP_TOKEN` only. `root_mcp::WIRED_CLIS` lists the CLIs that
  are named the server (Claude, Codex); `root_mcp_status` carries it.
- **Root and MCP are two chips.** Root lets an agent or model run in the root
  console; MCP runs it there *with* the tools, so switching MCP on switches
  Root on and Root off takes MCP with it. A root tab without MCP gets nothing
  at all — no server, no token, no env pair. Cloud CLIs are opted in by
  binary (`settings.root_mcp_agents`, the only name the spawn sees); unset
  falls back to `root_agents`, because before the chip was a switch every
  root agent got the tools. An unwired CLI's chip is dimmed and can't be
  switched on. So
  no agent carries the token in its *own* argv. This is what keeps it off
  disk, too: a fenced argv is past tmux's message limit, and `tmux_local` then
  writes the whole command line into a launcher script under the state dir. On
  a tmux without `new-session -e` (< 3.2) that script would also hold the
  exported environment, so the token is left out of it and travels as an `env`
  prefix on tmux's own, short argv instead — which tmux hands to `sh -c`, so on
  such a tmux the token *is* in the client's and that shell's argv, and
  `/proc/<pid>/cmdline` is readable by **every local user**, not only yours.
  Keeping it out of there too would mean a file on disk, which is the thing
  that must not happen. On tmux ≥ 3.2 no token value is on any argv (#864):
  the three MCP tokens are left off `new-session -e` and listed in tmux's
  global `update-environment` (fixed slots from 8630), so tmux copies them
  from the client's *environment* (0400) into the new session — and marks
  them removed for a tab that has none, so no tab inherits the token of the
  tab that happened to start the tmux server. The same slots carry the other
  per-tab secrets (`tmux_local::SECRET_ENV`): the schedule, git, help and
  markup MCP tokens, `COPILOT_GITHUB_TOKEN`, and from 8636 the provider API
  keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `MISTRAL_API_KEY`, `services::agent_api_keys`). Those stay set on the user's
  default tmux server, so a later session there takes the variables from its
  client or drops them. A provider key is never sent through a tmux < 3.2 at
  all (`launch_prep` drops it). After a fenced command the pane's trailing
  login shell — unfenced — starts with `env -u` over every one of them.
- **Hidden from fenced project agents.** Bubblewrap gives each fenced agent its
  own pid namespace and `/proc`, so it cannot read the root agent's environment
  or argv.

**Known limit.** An agent you chose to run *unfenced* shares your uid and can
read `/proc/<pid>/environ` and `/proc/<pid>/cmdline` of a root agent. That is
what turning the fence off means, and the token does not pretend otherwise.

**Known limit, inherited.** The token reaches the CLI through its environment
(`${TABTIVITY_ROOT_MCP_TOKEN}` in Claude's inline config, `bearer_token_env_var`
for Codex, `api_key_env` for Vibe — each CLI reads it by name, so there is no
way to hand it over that leaves it out of the process environment), and the
environment is inherited: anything the agent runs in that tab — a git hook, a
package script, a Makefile, a `curl` — holds the token and can call the tools
as the tab. The same holds for a project agent's schedule token. The fence
does not narrow this (the root fence's roots are `~/tabtivity/root`; a project
agent's fence contains its project, and the schedule endpoint is loopback
either way). One exception widens the root fence: with
`root_fence_projects_readable` on (default off), a root spawn also gets every
local project directory, box folder and remote mirror **read-only**
(`agent_fence::root_project_read_only_paths`, the `extra_ro`/`readable`
channel, never `roots_for_scope`, whose roots are read-write binds; the state
masks still win, so a default mirror under `remote-projects/` stays hidden).
It is a widening on purpose — a root agent that reads every project reads
untrusted text from all of them and has the open network — so it is a switch,
recorded per tab at spawn as the exact paths its sandbox bound
(`Session::projects_grant`; everything for an unfenced agent) and read by the
mail `attach` argument, never the live setting or project list — a project
added after the tab started is refused until a new root tab is opened. So an audit record is the **tab's**, not necessarily the agent's
own call, and the *MCP session access* fold says so. The one thing that would
close it — the CLI reading the secret from a 0600 file and scrubbing the
variable before it spawns children — is the CLI's to do, not Tabtivity's.

**Browsers.** A request carrying an `Origin` header is refused. Browsers send
that header on cross-origin POSTs and agent CLIs don't, so a web page cannot
reach the tools through your own browser, DNS rebinding included.

**Approved writes reach the window.** By default a tool writes its tab's copy
and records a proposal. Approval emits `root-mcp-changed` with the applied row
(the lower review levels described below can also apply immediately). The
overlay host merges the row into the calendar store and announces it through `notifyCalendarWrite`, so a CalDAV-backed calendar pushes
it exactly as it would a dialog edit.

**The board's tools are the board's gestures.** `todo_add`, `todo_update`,
`todo_complete`, `todo_reopen`, `todo_move` and `todo_delete` go through the
same task CRUD and the same `move_tasks_at` a drag uses, so the rank algebra and
the done↔column coupling stay in one place. A move can reindex a whole column,
so one call may emit several rows. Rows whose only change is `column`/`rank`
carry `local: true` and are merged without a CalDAV push, which is what a drag
on the board does too — no server stores those fields. A delete is permanent
and its tool description says so; the row rides along so the CalDAV copy can
still be addressed.

**The sweeps answer for every project at once.** `projects_git_status`,
`sync_status`, `time_summary`, `usage_recap` and `boxes_list` are the questions
a *project* agent structurally cannot answer — which projects have uncommitted
work, whether anything is out of step with its host, how long last week went.
`project_activity` is the sixth: one project's git state and latest commits.
All of them read files Tabtivity already owns and none opens a connection — with
the one caveat every git call here carries: `hookless_git_command_in` first
strips program-naming keys from the repo's `.git/config`, and the tool
descriptions say so rather than claim a pure read. `project_activity` passes
`--no-show-signature`, since a repo's `log.showSignature` would run its own
`gpg.program`. A sweep that runs short of its request deadline answers with the
rows it has and lists the unreached projects under `skipped` (`incomplete`):
a snapshot is only started while it can still finish. The sweeps run *before*
the review lock is taken, so a long one never stalls a review decision or a
tab teardown. The git sweep runs `git` on the **local** working copy only: a
remote project through its mirror, and reported as skipped, with the reason,
when it has none. `sync_status` reports what the last pass recorded rather than
probing the host. A synchronous SSH round trip inside a tool call would stall
the handler for as long as a dead session takes to time out, once per project —
the freeze the remote UI's connected-gates already exist to avoid. The git sweep
also runs with `GIT_OPTIONAL_LOCKS=0`, because a background reader that
refreshes the index takes `index.lock`, which is half of the root git-status
loop.

The two rollups are bucketed by **UTC** date, since that is how
`time_summary.json` and `usage_stats.json` were written; the tool descriptions
say so rather than passing them off as local days. Tabtivity's own window time is
reported as `app_seconds` and never inside a project's total, and a scope whose
project has since been deleted keeps its bare id — the hours are still real.

**A read is a view, never the stored row.** A root agent is kept from mail
because mail is text anyone can send you, and an invitation's title or a
subscribed calendar's notes is the same kind of text. So `calendar_list`,
`todo_list` and every write's reply go through `event_view`/`task_view`: an
explicit field list (no `caldav_href`, etag or other server-parked `extra`),
`strip_invisible` over every string, `external: true` plus `redact_urls` for a
row in a read-only calendar, and `synced: true` for one that lives on a CalDAV
server, where invitations land beside the user's own entries. The `Change` rows
the window and the review layer use stay complete. `calendar_list` matches an
event while any of it overlaps the range, and `expand` adds a series'
occurrences (at most 92 days; `occurrences` in `root_mcp.rs` walks daily /
weekly / monthly / yearly rules and says so when it meets a numbered weekday or
an imported RRULE it cannot). `calendar_free_busy` is built on the same walker.
Pagination cuts only the array a tool is about (`paged_key`), and a cut page
says `truncated` in words.

**An event is edited, not re-created.** `calendar_update_event` closes the gap
that made rescheduling a delete plus an add, which loses the row's identity: a
CalDAV server would see a cancellation and a new invitation instead of a change.
Moving `start` alone keeps the event's own length — an agent that omits `end` is
moving the event, not resizing it, and `calendar_add_event`'s one-hour default
would quietly shorten a three-hour meeting every time it was moved. An event in
a read-only calendar is refused before anything is written locally, because the
window could not push it.

**A move between calendars is a delete plus a create, on the server only.**
`calendar_move_events` (a list of ids, or every event in one calendar) and
`calendar_update_event`'s `calendar` share one path,
`commands::calendar::relocate_event`. The event dialog's calendar picker takes
the same path through `stores/calendar/calendar`'s `updateEvent`. Locally the event
keeps its id, so
anything that links to it keeps working. A row synced from a CalDAV server is a
resource inside one collection, though, and its address cannot come along.
Pushed under its old `caldav_href`, the moved row would `PUT` straight back into
the collection it left, and that calendar's next sync would restore a copy
there. So the move drops the address and emits two changes in order. First
comes a `delete` carrying the row as it was, which retires the old copy through
the ordinary CalDAV hook. Then comes an `upsert`, which the new calendar pushes
as a create. If that delete hits a conflict, "Keep mine" removes only the old
copy (`resolveKeepMine` checks that the row still has that address), never the
moved event. A series whose occurrences were edited on the server is several
rows sharing one resource, and pushing those rows one by one would split it, so
it is refused. A batch is one atomic write: every event moves or none does.
`calendar_create` makes a local calendar only. CalDAV calendars come from a
subscription, and nothing here creates a collection on a server.

**Tools say what they do, not whether to ask.** Each tool carries MCP
annotations: the `*_list` tools and the read-only sweeps are `readOnlyHint`,
and the deletes, `todo_update`, `calendar_update_event`, `calendar_move_events`
and `mail_draft_update` are `destructiveHint`. Codex asks before any tool not marked
read-only, so reads now go through without a prompt and writes still ask.
Tabtivity never passes `default_tools_approval_mode`: approval is the CLI's own,
like its permission mode.

**One switch turns it all off.** `settings.json`'s `root_mcp` — absent means
on — is read per spawn and per request rather than at startup, so it needs no
restart in either direction. Off closes both halves, because only one would be
a lie: a root agent spawned from then on is handed no endpoint, and the
endpoint answers `503` to the agents that already hold the token. The check
sits after the bearer check, so an unauthenticated caller learns nothing from
it. The listener itself stays bound; rebinding would mint a port the running
agents were never told about, and turning the tools back on would not reach
them. Settings is now the one door onto that key: the console's ⚿ badge became
the door to the proposals panel, since a badge that both reported the switch and
flipped it on a plain click was one click away from silently disarming the tools
while the user was reaching for the pending rows.

**A second switch keeps the tools local.** `root_mcp_local_only` (absent means
off; Settings, under the main switch) serves local-model tabs only, so the
calendar and board never reach a hosted model through these tools. It closes
both halves the same way. Each token maps to its PTY tab id and
`Caller::{Agent, LocalModel}`; Vibe carrying
`TABTIVITY_LOCAL_MODEL`/`VIBE_ACTIVE_MODEL` gets the local class. On, a cloud agent
is handed nothing at spawn and the endpoint answers `503` to its token;
local tabs opened before the flip keep working. A model still needs its "MCP"
chip to get tools at all.

**Failure is safe.** If the listener cannot bind, the overlay's ⚿ badge reports
it unavailable. If the OS cannot provide entropy at spawn, that agent is handed
no token and no tools.

## Mail

The
tools live in `services::root_mcp_mail` — nine names, pinned by a test — and
are new entries in this same server, not a second one.

**Mail is switched on separately, and starts off.** `root_mcp_mail` (absent
means off; Settings, under the main switch) is the one gate above the whole
mail surface: `root_mcp` alone never brings mail with it. Off, `tools/list`
carries no mail tool, a call to one answers `root_mcp::MAIL_OFF` by name, a
reader is handed no endpoint at spawn and `serves` refuses the readers already
running (a reader exists for mail alone), and the ⚿ badge shows no ✉. Read per
request like the other two switches. The per-account `agent_access` sits below
it and still decides which accounts a reader may read.

**The caller class is fixed at spawn, with the token.** `Caller::{Agent,
LocalModel}` is a root tab; `Caller::Reader` is an agent tab in a `mail_reader`
VM project (`docs/context/vm_projects.md`). `root_mcp::served` is the one class
table: `tools/list` and dispatch both go through it, so a tool outside a class
does not exist for it — the same "unknown tool" an invented name gets.

- **A cloud root tab never reads mail.** It has a shell and the open network,
  and mail is text anyone can send you. It gets the draft tools and
  `mail_accounts_list`, nothing else; its draft schema has no recipient and no
  reply argument at all, so its drafts always have an empty `to`.
- **A local-model tab** is the same, unless `root_mcp_mail_local_read` is on
  (`Policy::reads_mail`): then it also reads — marked mails only, loopback
  Ollama only — because its sole tools are this server's (Vibe's
  `enabled_tools`). Its first read latches `Session::has_read_mail`, after
  which it is treated as a reader for writes: always staged, tainted, reader
  drafts. `served` lists the read tools for `LocalModel`; the switch decides
  per request.
- **A reader** gets the read tools (`mail_folders`, `mail_search`, `mail_read`,
  `mail_thread`) and the draft tools, is served **no cross-project sweep**, and
  its calendar/board writes **always stage** with `tainted: true`, whatever
  `root_mcp_review` says. Each of its mail calls re-checks that its VM is still
  narrow (`services::mail_reader::refusal`, gathered by
  `commands::vm::mail_reader_refusal`).
- Reading needs the per-account opt-in `MailAiPrefs.agent_access` (off by
  default, in the account dialog). An account without it does not exist for a
  reader: same `unknown account` as an invalid id.

**What holds when the model ignores the envelope.** Every result carrying
sender text (`mail_search`, `mail_thread`, `mail_read`) is wrapped whole in a
per-call-nonce envelope — hygiene only. The load-bearing parts are the class
dispatch, the missing arguments (no bcc, no attachment, no path, no URL),
`strip_invisible` over every emitted string (so the transcript shows what the
agent saw) and `redact_urls` (link *texts* only; a URL is a pre-built
exfiltration target). Encrypted mail is opaque: headers and the verdict, no
body.

**Drafts.** `MailDraft.origin` is `"agent"` or `"reader"`; each spawn lists,
updates and deletes only its own (the persisted `owner_session` binds it), and `mail_draft_save` (the composer) clears
both origin and owner, which puts the draft out of the agent's reach. Agent
changes compare the previous row atomically under the mail database lock: a
composer save also defeats an already-running agent update or delete. Older
class-only drafts remain available to the user in the composer. A reader's recipients must
already be on the replied-to message. A draft is not a staged `Proposal`: it
lives in the mail store, shows in the review panel as a row that *opens the
composer*, and `mail_draft_send` stays a Tauri command — nothing here sends.
The `root-mcp-changed` event gains `kind: "draft"`, carrying the id and origin
only.

**Attachments and suggestions (root tab only).**
- `attach: [{project, path}]` (≤ 5) on `mail_draft_create`/`_update`, replace
  semantics. Refused unless the tab's spawn record says its fence shows the
  projects, and on Windows. Resolution is the **same-roots rule**
  (`services::mail_attach`): the roots a fenced tab of that project gets
  (`agent_fence::attach_roots`: a remote project's mirror, never its remote
  `directory`), none at `/`, at or above `$HOME`, or in the state dir; the path
  checked before I/O and opened by an `openat(O_NOFOLLOW)` walk, `O_NONBLOCK`
  and `fstat`-regular for the file, nothing in `.git`, capped at 20 MiB a file,
  25 MiB a draft and 100 MiB a tab. The bytes are copied into the sealed outbox
  when the agent calls; the reply carries filename, size and sha256.
- The `staged` table carries `origin` and `source`; it is the truth Send
  reads. An agent write refuses once any row of the draft is the user's
  (`MailStore::change_draft_files`, one lock), and an agent delete removes the
  outbox copies.
- `suggested_to` (≤ 5, syntax-checked) is stored, never copied into `to`, never
  read by a send, not echoed by `mail_drafts_list`; the composer shows each as
  an "Agent suggests: X — Add" pill.
- **Send is bound to the reviewed set.** `mail_agent_drafts` fills
  `staged` from the table and the composer shows each agent file with its
  source; `doSend` stops when the saved set differs from the one on screen, and
  `mail_draft_send(stagedIds)` refuses in the backend when the store's set
  differs or the draft was never saved by the composer.

**Locked means refused.** `commands::mail::AgentMail` never opens the store: not
opened this run, or opened as the memory-only stand-in, both answer "mail is
locked, unlock it in Tabtivity first". No tool unlocks and none prompts.

**Reader credential transport.** The host SSH command contains only the name
`LC_TABTIVITY_ROOT_MCP_TOKEN`. SSH sends its value through the encrypted environment
channel (`SendEnv`); the provisioned guest's standard `AcceptEnv LC_*` accepts
it. The guest exports the actual MCP variable and passes the locale variable
into a new tmux session with `-e`. A guest that rejects the channel fails before
launching the agent; no config file is edited and no plaintext/argv fallback
exists. The host environment and guest processes still carry the secret, so the
same-uid unfenced-process limitation still applies. Natural PTY exit retains
the token identity for generation-safe revocation.

`agent_warmup` builds its own `Command` and never reaches `pty_spawn`, so an
unattended run gets no endpoint; future scheduled-agent spawns must opt out.

## Importing an `.ics`

`calendar_import_ics` (`services::root_mcp_import`) takes the file's **text**
and nothing else. There is no path and no URL argument on purpose: this process
is not fenced, so a path would let a fenced agent have Tabtivity read what its
fence hides (a symlink named `x.ics` is enough), and a URL is a fetch the agent
aims. The text is capped at 96 KiB (`maxLength` in the schema, which
`root_mcp_security::validate` honours in place of its 32 KiB default; the
request body is 128 KiB).

**The backend does not parse it.** `commands/calendar.rs` keeps iCalendar out of
Rust, and a second parser would be a second attack surface drifting from the
first. The tool checks only that the text claims `BEGIN:VCALENDAR` and writes it
to `<state_dir>/root_mcp/imports/<id>.json` (5 per tab, 20 in all; inside the
fenced-off state dir). The reply carries the id and no word of the file.

**Like a mail draft, it is not a `Proposal`.** It shows in the review panel as a
card whose body is the window's own `inspectIcs` report — the same
`IcsReportBody` the Import button's dialog shows — and ✓ runs the same
`stores/calendar/importIcs` the button runs, on exactly the text reported on.
So it stages at every `root_mcp_review` level including `off`, is never part of
"Approve all", and lands in a **new local calendar**, never a CalDAV one: an
invitation cannot be pushed to a server as the user's own entry, and undo is
deleting one calendar. The import runs *first* and the staged copy is removed
once it is in: a failed import keeps the card and shows the error, the importer
deletes the calendar it began when a row fails (or names it, should that delete
fail too), and the window remembers which staged ids it imported so a card
whose removal failed cannot be approved a second time into a second calendar.
Needs the
all-calendars grant and write access; a reader is not served it (it is handed
no attachment, and this must not become the way one reaches the calendar).

**The importer marks the calendar `imported: true`** (in `extra`, for the
button's imports too). `event_view` and `todo_list` show such a calendar's rows
`external` with URLs redacted, as for a read-only feed — without the mark, a
file's text would come back to the agent as the user's own. No tool edits a
calendar's `extra`, so an agent cannot clear it.

## Staged writes

`settings.root_mcp_review` defaults to `all` (including unknown values): calendar
and board tools write only a per-tab copy under
`<state_dir>/root_mcp/sandboxes/<hash-of-pty-id>/calendar.json`. The copy is
rebuilt when the real file's content hash or the tab's pending proposal sequence
changes; its own hash detects a failed or incomplete tool write. Rebuild starts
from the real store and replays pending rows in order. It never copies the
sandbox back over the live file.

`services::root_mcp_review` owns the immutable proposal rows and the atomic log
at `<state_dir>/root_mcp/proposals.json`. It keeps every pending proposal and
the newest 200 decided entries; unknown future statuses and extra fields
round-trip. A first board move also records seeded columns, upgrade markers and
normalized sibling rows, so applying or undoing it does not lose those effects.

Only the Tauri review commands approve, reject, bulk-approve or undo. Approval
binds to the digest of the displayed rows and their calendar routing context.
All rows must pass under the calendar's existing RMW lock before one atomic
write: creates require an absent id, edits/deletes require the original row.
The only ignored row fields are `caldav_href` and `caldav_etag`, precisely the
fields written by `set_caldav_identity_at`; current identity is retained on
ordinary edits and deletes. A calendar relocation still deletes the old server
copy before creating the new one. Calendar routing/access changes conflict too.
A conflict cannot be force-applied. Rejection rebuilds the tab's view and
conflicts dependent proposals. The next successful tool call reports their ids
in `dropped_proposals`; `proposals_list` reports only its own tab's statuses.

The proposals hang from the console's ⚿ badge as a panel (the shared
`ContextMenuPortal`: click-away, Escape, viewport clamp), not as a strip under
the title bar — that strip took a slice of the terminals' height to say "(0)"
most of the time. The panel shows actual field changes, folds only sibling board
reindex rows, strips invisible controls, and labels CalDAV outbound effects; a
decision is one glyph, ✓ or ✗ (a conflict's ✗ discards), each still *named*
"Approve"/"Reject" for the tooltip and the screen reader. The badge therefore no
longer toggles the tools: Settings is the one door onto that switch, and the
badge reports its state as before. The project bar carries a pending-count ⚿
button while the console is closed, and it opens the console with the panel
already down. Bulk approval submits the explicit displayed id/digest pairs, so
newly arriving proposals cannot join a click already in flight. Open reviews refresh conflict
status every five seconds. These surfaces still carry `UntestedTag` until live QA.

The `destructive` level stages tools with `destructiveHint`; other write tools
apply immediately and appear in the log with conditional Undo. Undo uses inverse
rows and the same preconditions, never overwriting a subsequent user edit. An
automatic write depending on an unapproved row conflicts instead of bypassing
that row's gate. `off` uses the original direct path. Changing levels affects
the next request; already-pending proposals still need a decision.

Tokens are fresh per spawn and revoked on tab teardown (including failed
spawns). Teardown removes only the copy, retaining proposals as from a closed
tab; every copy left by a crash is swept at startup and again on a clean quit,
after the listener stops accepting and the workers in flight get a short
drain. The same PTY id on resume finds its proposals (`proposals_list` is per
tab) and its mail drafts (owned by `sha256(tab)`) with a fresh token, and
starts tainted if any earlier spawn of it read mail (the marker under
`root_mcp/read_mail/`). The runtime itself contains only the listener port,
never a shared secret.

An automatic write (`destructive` level) is applied first and logged once, so
the log never says `pending` for a change that landed; one the store could not
take for a reason other than a stale row is logged `failed` (with the error),
not `conflicted`, and the agent is told to propose it again. `list` also
re-reads a pending automatic row whose rows already hold as `applied`.

Refusals by name: a tool the user took away in *MCP session access* answers
`ACCESS_NARROWED`; a local-model tab's mail read tool with the local-read
switch off answers `LOCAL_READ_OFF`; only a tool outside the caller's class
answers `unknown tool` (so a cloud tab never learns mail read tools exist).
Over HTTP, a revoked or re-granted session gets its own 401 text rather than
the 503 "switched off in Settings"; requests refused before they authenticated
are audited as bounded, masked `admission` rows.

The gate holds only while root agents are fenced. `root_mcp_status` carries
`review_enforced` (fence policy on for root, platform fenceable, bubblewrap
present); when it is false the ⚿ badge shows ⚠ and the review panel says that
review is advisory, because an unfenced agent can edit the store or
`root_mcp_review` itself.

This is a write-integrity gate, **not confidentiality protection**. Calendar
visibility scoping is a separate read-gate feature and has not shipped here;
fenced agents can still disclose what tools let them read. An unfenced agent
can access the real store directly. Mail shipped on this surface
(`services::root_mcp_mail`): the reader class and a
local-model tab that has read mail always stage, their proposals carry the
mark, drafts are the proposal and the composer's Send the approval. No send or
approval tool exists on the endpoint.

## MCP security policy and session controls

`root_mcp_security` owns the explicit tool policy. A new tool has no caller
class until assigned one. Listing and dispatch use that registry and the
session's grants; MCP annotations are derived descriptions, never the source
of write-approval decisions. The ordinary CLI permission mode remains its own.

One validated settings snapshot determines each request. Missing, malformed
or unreadable settings refuse access, including at spawn. Missing keys in a
valid existing settings object retain the historical defaults. Requests check
that the security policy still matches their snapshot after lock waits and
before protected operations; a changed policy requires a fresh request.

Settings → MCP session access grants tool families, read/write access and
calendar/project/account scopes for a running session. These grants are
memory-only and die with the spawn. Root sessions retain the existing broad
defaults; readers start with mail only and still require per-account opt-in.
The `all` scope explicitly includes future entries; a selected-id scope does
not. A grant cannot override a role prohibition (root agents never read mail,
readers never get project sweeps). Clients may need to refresh their tool list
after a grant expands. The controls carry `UntestedTag` until live verification.

Calendar copies are filtered by grant, project summaries exclude denied
projects, and mail resolution/draft ownership is scoped before returning data.
Scoped calendar/board writes always stage. Both old and new rows must remain
inside the grant, including side effects: a board normalization or reindex
that changes shared structure outside the scope is refused. Calendar creation
requires the all-calendars grant. A proposal binds its original grant, caller
and spawn into its digest, and approval also checks an active spawn's current
grant. Closed-tab proposals can still be approved by the user within their
recorded original grant. Read-only sessions cannot create proposals or alter
drafts. None of this prevents an agent from leaking data it was allowed to read.

Changing grants or revoking access invalidates queued requests immediately.
Operations already past their mutation check may finish; revocation/grant
commands wait for those operations before returning. Completed changes retain
their normal UI events. Natural exit and failed-spawn cleanup cannot revoke a
replacement generation or remove its sandbox. Revoking access never closes
the terminal.

The HTTP server authenticates before collecting a body, rejects all Origins,
and accepts only its loopback authority or the fixed reader guest authority
(the latter for readers only). Bounds: 32 sockets with 30-second lifetimes (one HTTP/1 request per socket; replies
close the connection so a later write cannot outlive an old keep-alive socket),
8 workers, 2 requests per spawn (a third queues for up to 8 seconds rather than
drawing a `429`, which a CLI firing parallel calls reads as a broken server; the
15-second work deadline counts from admission), 120 requests per spawn per minute, 128 KiB
request bodies with a 5-second upload deadline, and 512 KiB serialized replies.
A worker retains its permit even if HTTP disconnects. Work has a 15-second
cooperative deadline; git subprocesses have a 3-second deadline and bounded
output, with their subtree killed/reaped on cancellation. Mail fetches time out
after 8 seconds. These bounds do not make uninterruptible OS filesystem I/O
cancellable.

Read tools expose bounded pages (`offset`/`limit`, with `next_offsets` for
non-mail arrays). Mail retains its existing row/body caps. Argument types,
required fields, extra keys, ranges, strings and arrays are checked before
dispatch. Calendar moves expand to at most 50 events. Pending proposals cap at
100 per tab / 500 total and the log at 8 MiB, without evicting undecided work;
agent draft creation refuses when the mail store already has 500 drafts.
Large successful write receipts are shortened without losing change events.

The audit retains at most 500 records in memory, with the latest 50 shown in
Settings: spawn id, caller class, known tool name, outcome and timing. It never
records tokens, arbitrary arguments or message bodies and resets on app exit.

On Linux the fence finally shadows the entire state directory and its
canonical alias, then restores only explicit agent-support mounts. Project
roots, tool installs and user read allowlists cannot reopen it. Symlink targets
of private stores are masked too. macOS denies the known private stores after
its path grants; Windows and deliberately unfenced agents retain their existing
limitations. New private store paths must be added to the macOS deny inventory.

## On the phone

Root used to be kept off Tabtivity Mobile outright, on the grounds that its agents
hold rights no project agent has. That guarded against the wrong party. Those
rights separate a root *agent* from a project *agent* — fenced processes that
read untrusted text. The phone is the user, on a paired device that signs a
challenge with its own key, and it can already open an unfenced shell in any
Mobile-enabled project: a shell that runs as the user and can read every store
these tools serve. Keeping root away took nothing from someone holding the
phone and kept the user from their own root agent away from the desk.

So root is a phone scope, behind a line drawn where the rights actually are:

- **Its own switch, default off** — `tabtivity_mobile_host.root_access`, in
  Settings → Tabtivity Mobile. Root is in neither `projects.json` nor
  `boxes.json`, so it cannot carry a per-record switch; `discovery` lists it as
  `ScopeKind::Root` from `paths::root_work_dir()` and `sessions/root/`. A
  hand-edited *project record* using the id `root` is still refused: it would
  borrow that session directory and walk past the gate below.
- **The device that drives the agent never approves its proposals.** Approve,
  reject, undo, the session grants and Settings are Tauri commands with no
  phone route. The phone's root row carries `pending_reviews`, a count.
- **Closed while review is weaker than default.** With the MCP tools on, root
  is listed only while `root_mcp_review` is `all` *and* a root agent would run
  fenced (the `review_enforced` facts) — otherwise a prompt typed on the phone
  would write the calendar at once with nobody at the desk. With the tools off
  a root agent holds nothing extra and the switch alone decides.
  `discovery::root_open` reads this per catalog load, so weakening review
  drops root from the phone and `pty_bridge`'s re-check detaches its open
  terminals. `MobileBridgeHost.mobileRootScope` repeats the rule, because the
  bridge is reachable without the sidecar route; Settings says why when the
  switch is on and the gate is closed.
- **No phone-only kind of root agent.** A tab created from the phone goes
  through the same `pty_spawn` with no project id, so `apply_to_spawn` decides
  its tools by the same Root / MCP chips as a tab made at the desk. "Activate"
  raises the console (`useRootOverlayStore.show`); root is never switched to.
- Root Claude tabs still spawn without `--remote-control`, so they never appear
  in Claude's own phone app — a different decision from Tabtivity's paired phone.
- **The phone's raw terminal input is trusted as the user's, and reaches the
  pane only.** Tabtivity sets `prefix None` on every tmux session it creates
  (`tmux_local::local_tmux_args`, `ssh_exec::tmux_wrap_exec`; session-scoped,
  so a user's own tmux sessions on the same server keep theirs). Both clients
  already ran `status off` and nothing of Tabtivity's binds the prefix, so nobody
  loses a key — and without one, no keystroke from a paired phone can open
  tmux's own command line and detach, rename or spawn past the review gate
  above. Decided 2026-09-24.
