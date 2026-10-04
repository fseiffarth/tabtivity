# Agent schedule MCP

Desktop v1. It is globally off by
default. Settings → Manage CLIs enables it for new local project-agent spawns;
each project's trusted `projects.json` entry selects `off`, `propose` (default),
or `apply`. The project pill menu also exposes this level. Nothing is written to
the project's own configuration or another application's configuration.

The shared loopback listener dispatches `/mcp/schedule` separately from `/mcp`
before reading request bodies. Only `Caller::Scheduler` tokens enter the former;
they never enter the root tool registry. A token binds one project, tab and stable
schedule target at spawn. Claude and Codex receive their existing per-invocation
MCP flag recipes with the server name `tabtivity-schedule`; opted-in Vibe models get
their env configuration. Other CLIs get the inert URL/token env pair only.
Remote hosts (including workers), VM and container projects receive no token.
Local tmux launcher scripts omit schedule secrets just as they omit root secrets.
Close, natural exit, failed spawn and session revocation invalidate the token.

**Tabs the Mobile host starts with no window** (phone ＋, the scheduler's
restart) get the same server from the host's own listener and token store
(`docs/headless_mcp_plan.md`): each process serves the tabs it spawned, tokens
stay in memory, and a token is refused by every other process's listener. The
proposal lands in `agent_tasks.json` under the file lock like any other; the
host pokes an open window (`refresh`, slice `schedules`), otherwise the card
appears when a window loads the rows. Such a session is not in the window's
MCP session access; it ends when the tab's tmux session is gone (the host's
sweep) or the host stops. A host restart leaves the tab without the tools
until it is restarted.

The three tools are `schedule_prompt`, `list_my_schedules`, `cancel_schedule`.
Arguments are strict, every schema field carries a description, and they contain
no scope selectors. Weekdays are numbered 1 = Monday … 7 = Sunday, the numbering
`ScheduledAgentPrompt` persists and the schedule dialog uses — deliberately not
the calendar tools' 0 = Sunday, and the schema and `CONTRACT` say so. Agent messages have invisible
controls removed and whitespace collapsed; leading `/`, `!`, `#`, `$` and `@`
are refused. Agent rows cannot carry a preface. Cancellation cannot touch a user
row or an outstanding delivery claim. User-authored messages are listed only as
80-character previews. Audit entries retain the session, target and fixed refusal
category, never the prompt or arbitrary arguments.

Writes use the existing agent-task transaction lock. Limits are four pending
agent rows, one recurring row (always staged), five minutes' lead (a daily or
weekday rule whose next occurrence is inside the lead starts at the one after,
a one-time schedule inside it is refused), twelve create calls per rolling
session-hour, and six agent deliveries per target/local day. `schedule_mcp::admit`
validates the arguments and takes the hourly slot *before* any work — the
`after_usage_reset` usage probe included — so a malformed or over-budget call
spawns nothing and costs nothing.
The backend reserves delivery budget atomically with the claim, before input can
be written; unresolved crash claims conservatively consume budget. Failed and
missed receipts do not. The compact `agent_deliveries` journal survives rule
retirement/deletion and restarts, retaining seven days when another claim arrives.
It also supplies the most recent delivered record id for origin lineage.
Unapproved proposals expire after seven days; reads and MCP calls prune them and
the host refreshes hourly. Approved recurring rows remain until removed.

`after_usage_reset` reads the same `agent_usage` report used by auto-continue.
The backend parser in `schedule_usage` recognizes dated/weekday/clock reset
phrases and named IANA zones, choosing the soonest future reset plus one minute.
Unknown readouts return `unsupported`; the five-minute lead rule still applies.
Auto-continue stands down for an approved agent row at the same rollover.

Delivery still belongs solely to `AgentScheduleHost`, with its existing idle
gate and one-hour catch-up window. Proposals appear in the schedule dialog,
Agents view and prompt chart with Approve / Dismiss. Attribution survives into
sent history. The existing unread tab affordance rises once per pending batch.
Session controls show the project and offer revocation with optional proposal
removal. All new controls carry the `scheduleMcp` untested registry id.

Compatibility: existing schedule files retain their absent fields and version 1.
New `origin` and `agent_deliveries` fields cannot be read by older binaries whose
agent-task schema denies unknown fields; do not downgrade a shared state folder
after using this feature without preserving its newer `agent_tasks.json`. The
sent-prompt history has an optional `schedule_origin` field. This is a release
compatibility note, not a state migration or version bump.

Unfenced processes sharing the desktop uid can read each other's environment or
edit local state directly. Per-token scoping is not a containment boundary against
that access. Inside the tab the token is inherited: the CLI reads it from its
environment by name, so every process the agent starts (hooks, package scripts,
builds) holds it and can call `/mcp/schedule` as the tab, fenced or not — an audit
row is the tab's, not necessarily the agent's own call
(`docs/context/root_console.md`, *Known limit, inherited*). The delivery
permission mode remains entirely the agent CLI's own.

## User-run live QA

Do this after choosing to load a build with the updated backend; agents must not
restart the running app or close the user's tabs for verification.

1. Settings → Manage CLIs: turn on project-agent scheduled prompts. Leave a
   local project's level at Propose; open a fresh Claude tab in that project.
2. Ask it to schedule a plain test prompt in ten minutes. In its schedule menu,
   verify “Proposed by agent”, the time and message. Approve it; verify delivery
   waits for idle and appears once in the prompt chart's sent history.
3. Repeat in Codex and a fenced local tab. Check `/clear` and `!` requests are
   refused, a fifth pending row fails, and user-authored rows cannot be cancelled.
4. Choose Apply: a one-time row should enable immediately, while a recurring
   row still asks for approval. Verify the chart's origin and lineage.
5. In MCP session access, revoke the schedule session and optionally remove its
   proposals. Further calls must fail; the tab must stay open. A closed tab's
   token must fail as well.
6. On a later normal restart, verify resumable tabs keep proposals and delivery
   budget. Check auto-continue does not add a second prompt at a scheduled reset.

Phone approval controls, additional CLI recipes, tunnelling and root-console
scheduling are explicitly outside desktop v1.
