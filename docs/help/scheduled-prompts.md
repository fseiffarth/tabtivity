---
id: scheduled-prompts
title: Agents view, prompt chart and scheduled prompts
keywords: [schedule, scheduled prompt, timer, later, daily, weekday, chain, after, follow-up, prompt chart, collected prompts, drafts, agents view, working, needs a decision, finished, continue, auto-continue, rate limit, usage limit, reset, warm-up, cron, schedule_prompt, agent scheduling]
related: [agent-clis, root-console, tabs-and-panels, mobile]
---

Tabtivity can show what every agent tab of a project is doing, keep prompts
for later, send them at a set time, chain them, and keep an agent going past
its rate limit.

## The Agents view

The file panel's **Agents** view lists the project's agent tabs: **Working**,
**Needs a decision**, **Finished** or **Idle**, when each last worked or
finished, its last prompt and the model it runs. **Sort** puts what needs
you first (or by last finished, or tab order); **Go to** shows the tab. The
same states colour the project pills and the tab bar, and reach the phone.

Claude and Codex report their state through hooks Tabtivity installs in their
agent homes; for other agents it is a best guess from their output.

## Collected prompts

**Collected prompts** in the Agents view keeps prompts for this project that
belong to no tab yet. Write one and **Add prompt**; later **Send now** to a
**Target tab**, or turn it into a schedule.

## The prompt chart

**Open prompt chart** opens the project's prompts in a tab of their own, on
one zoomable time axis: drafts, queued, scheduled and sent prompts. Drop a
card on a tab's lane to schedule it there, or onto the now band to send it.
Select several cards to move them together, tag and filter them, and link
them: an **After** link makes one prompt follow another.

## Schedule a prompt

On an agent tab, **Schedule prompt…** (in the tab's menu, or **Schedules** in
the Agents view) opens its schedules. **Add schedule**, type the **Prompt**,
and choose the **Recurrence**:

- **One time** — a local date and time, or **In …** some hours or minutes from
  now;
- **Daily** at a time;
- **Selected weekdays** at a time.

When a prompt is due, Tabtivity waits up to one hour for the agent to be idle,
then types it in. **Delivery replaces any unsent text in the agent's input**,
even in the tab you are looking at. A prompt that could not be delivered in
that hour is marked **Missed**. Each tab holds one independent schedule; to
send more in order, link them **After** each other in the prompt chart. A
follow-up waits for the previous turn to finish, then for five quiet minutes.

Schedules run while Tabtivity is open — or, with Tabtivity Mobile switched
on, from its background service while no window is open. A tab that cannot
be resumed loses its schedules when it closes.

## Keep an agent going past its rate limit

**Continue** on an agent in the Agents view reads the agent's own usage panel,
waits until its limit window resets, and sends one "continue" a minute later
(at an idle moment, like a scheduled prompt), then arms the next one. An
agent with no usage panel cannot use it.

## Scheduled warm-up

**Settings → Agents → Manage CLIs → Scheduled warm-up** (under Advanced) sends
a short message to chosen agent CLIs in the background at set times — for
example so a subscription's usage window starts before your work day. Only
CLIs with a non-interactive mode can be warmed up, and only while a Tabtivity
window is open.

## Letting an agent schedule its own prompts

Off by default: **Let project agents propose scheduled prompts (MCP)** in
**Settings → Agents → Manage CLIs** (under Advanced). Local Claude, Codex and
tool-capable Local Model tabs then get three tools — `schedule_prompt`,
`list_my_schedules`, `cancel_schedule` — to schedule prompts for themselves.

Per project, on the pill menu (**Agent scheduling**): **Off**, **Propose for
approval** (the default: the schedule appears as "Proposed by agent" with
**Approve** / **Dismiss**) or **Apply one-time prompts immediately**.
Recurring prompts always wait for your approval. Limits: four pending
proposals per tab, one recurring, at least five minutes ahead, twelve
requests an hour and six deliveries a day. An agent cannot schedule slash
commands or shell escapes (`/`, `!` …), nor cancel a schedule you made.
Unapproved proposals expire after seven days. Remote, VM and container tabs
don't get the tools.
