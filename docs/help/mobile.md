---
id: mobile
title: Tabtivity Mobile (phone companion)
keywords: [mobile, phone, files, browse, project files, read-only, mark up, markup, annotate, pdf, markup_ask, questions about marks, tailscale, tailnet, pair, pairing, remote control, pwa, revoke, push, notifications, reminders, agent, question, connecting, not connecting, stuck, force stop, version]
---

Tabtivity Mobile is a small companion web app for your phone. It shows the
projects you opted in, their agent tabs (and shell tabs, if you allow them),
and one tab at a time as a live terminal you can type into — plus a to-do board, read-only mail and a
calendar, and — if you allow it — a read-only look at your projects' files.
It is a remote control, not a phone-sized Tabtivity: no editor, git, browser or
settings.

## Requirements

- Tailscale on this computer and on the phone. The app is reachable only over
  your own private tailnet, never from the public internet.
- A Tailscale Serve HTTPS root handler proxying to Tabtivity's loopback port, with
  Funnel off. Tabtivity checks this and refuses to start otherwise, saying what is
  wrong.

## Set it up

Until Mobile is set up, clicking the Mobile indicator in the header opens a
**Set up Tabtivity Mobile** guide with these same steps and a button for the
Tailscale command.

1. **Install Tailscale on this computer** and sign in. Tabtivity itself only
   ever listens on loopback; Tailscale carries the phone's connection.
2. **Install the Tailscale app on the phone** (or tablet) and sign in to the
   same tailnet.
3. **Publish Tabtivity privately with Tailscale Serve.** On this computer run
   (8742 is the default port; use yours if you changed it in Mobile
   settings):

   ```
   tailscale serve --bg http://127.0.0.1:8742
   ```

   The guide's **Set up in terminal** button runs it for you in a root
   terminal after asking. It takes over Tailscale Serve's HTTPS root (`/`), so
   check `tailscale serve status` first if something else is already served
   there. If Tailscale asks for approval or HTTPS setup, finish it in the
   browser it opens. Use Serve, never Funnel.
4. **Turn Tabtivity Mobile on.** Open **Settings → Remote & mobile → Mobile**,
   press **Detect Tailscale Serve settings**, check the computer name,
   loopback port and origin it fills in, then switch Mobile on. Tabtivity checks
   the Serve mapping before it starts the host.
5. **Choose what the phone may open.** Under **Project access**, switch on the
   projects and boxes the phone may reach. All start off. Only local,
   non-container projects are eligible. A switch turned on reaches **all
   phones**, including ones you pair later; to limit it, press the
   **All phones ▾** button beside it and pick **Only these phones**, then tick
   the phones. The side panel's phone button opens the same choice.
6. **Open it on the phone.** Press **Show install QR**: a root terminal checks
   the Serve mapping again and shows the `https://…ts.net` address as a QR
   code. Scan it with the phone (Tailscale must be connected there).
7. **Pair.** Click **New pairing code** on the desktop and type it on the
   phone. The code is valid for five minutes. Never send it by chat, e-mail or
   screenshot.
8. **Optional: install it as an app.** Add the page to the Home Screen
   (iPhone: Share → Add to Home Screen; Android: browser menu → Install app or
   Add to Home screen). On iPhone this is needed for notifications.

On Windows the phone cannot open this computer's terminals or agent tabs:
they attach through tmux, which Windows does not have.

An agent tab that was already running becomes reachable after its next normal
reopen, because the phone attaches to its terminal session.

### Which phones see a project

With two or more phones paired, a project or box can be limited to some of
them. A phone left off the list does not see the project at all: not in its
list, not by an old link or notice (it reads "no longer shared"), and it gets
no notifications for its agents. Taking a phone off while it has one of the
project's terminals open closes that terminal within a few seconds. Prompts
it already queued and schedules it made are not cancelled.

A box's own list decides which phones see the tabs opened in the box, in
member folders too; a member's list is about the member's own tabs.

At least one phone stays ticked; to reach no phone, turn the project's access
off.

## Using it

- Attaching to a running tab keeps working while the desktop Tabtivity is closed
  or restarting.
- Creating a new tab from the phone goes through the running desktop, so
  Tabtivity must be up.
- A paired phone types into a terminal exactly like your keyboard: keep agent
  approval modes conservative while Mobile is on.
- An agent tab opens as a **Chat**: the conversation as messages, a text box
  to write the next one, and the agent's questions as buttons to tap. Tap
  **Chat** again to choose whether it shows the stored conversation
  (**Session**) or the screen as text (**Screen**); **Terminal** shows the
  real terminal. A shell tab has no conversation, so its switch reads
  **Reader** (the screen as text) and **Terminal**. The desktop offers the
  same chat on its agent tabs (help topic `agent-clis`).
- Over the chat, **Files (n)** lists every file the conversation carried —
  what the agent sent from this tab and what you sent with your prompts —
  newest first, with who sent it; tap one to open it. It sits beside
  **Subagents (n)**; one list opens at a time.
- A PDF or picture in an agent tab's viewer has **Mark up**: draw on it and
  **Submit** sends the marks to that tab. The view stays open — the sent marks
  dim, a pill says what the agent is doing, you can keep marking (the next
  Submit sends only the new marks), and once the agent is done and the PDF
  changed, the rebuilt file loads under your marks on its own (turn that off
  in the palette's ⋯ → **Reload when the agent finishes**; then **Reload PDF**
  does it). Each marked page goes to the agent as a picture with your marks
  drawn on, together with the words each mark is on and — for a project PDF
  built with SyncTeX — the source line they come from, so a plain correction
  needs no hunting. The sent marks stay until you erase
  them, so you can check each change. By default the agent makes the changes
  at once, rebuilds and sends the PDF back; once it is done the pill offers
  **Undo**, which lists the files it would put back and, on **Undo**, puts
  them (and the PDF) back as they were before the round, reloads the PDF and
  tells the agent — it refuses, changing nothing, when one of those files was
  edited since. Where no undo can be kept (not a git repository, a remote
  project, a picture, too many untracked files) the pill says so and the
  agent first only lists the changes; tap **Make these changes** to let it go
  ahead. Home → This phone → **Mark up prompt** has the **Apply marks
  directly** switch (off: always list first), both prompts, and a slider for
  how often it asks you about a mark, from **Ask always** to **Never ask**. A pen (Apple Pencil, a stylus) needs no
  **Mark up** tap: touch a page with it and it starts marking, as in the
  phone's own Markup and Notes; fingers still scroll. A PDF the agent sent
  from inside the project opens as that project file while **Project files
  on the phone** is on, so it shows the same marks wherever you open it —
  the chat, the 🖼 gallery or the 📁 drawer. The palette's ⋯ has **Clear
  page** and **Clear all marks** (Undo brings them back), and ↑ ↓ at the
  right edge jump to the previous or next mark of a PDF. ⋯ → **Each Submit
  to a new subagent** (off by default) has the agent pass every round to a
  new subagent of its own and be free again at once, so rounds run side by
  side instead of one after the other — for agents that can start subagents,
  such as Claude Code; others do the round themselves. Home → This phone →
  **PDFs open in** picks how a PDF opens: **Automatic** (marking once you draw
  with a pen only, or while marks wait to be submitted; reading otherwise),
  **Reading** or **Mark up**. The desktop's PDF viewer has the same **Mark up**
  for local projects, with its own prompts in Settings → Agents → **PDF markup**
  (and the switches for loading a rebuilt PDF under your marks by itself and
  for handing each Submit to a new subagent).
  When a mark leaves the agent a choice it can ask you right there (see
  "The agent's questions about your marks" below).
- **No shells on the phone** (under **Project access**, on by default) keeps
  the phone to agent tabs: shell tabs are left off its lists, an open one
  disconnects within seconds, and **＋** offers no shell. Switch it off to
  see and open shells from the phone — they run as you, with no agent's
  permission prompts in between.

## The agent's questions about your marks

When a mark is ambiguous ("does this arrow move the paragraph or the
figure?"), a local Claude or Codex tab (or a Local Model tab with the
**MCP** chip on) can ask you with its `markup_ask` tool instead of in its
chat. The questions show in the markup view of that tab's PDF:

- On the desktop, as a card under the **Mark up** bar while marking is on.
  With marking off, the **Mark up** button is underlined while a tab asks
  about the PDF, and opens the bar on that tab. While you mark for one tab
  and another asks about the same PDF, the bar names it: **Show its
  questions** switches to that tab.
- On the phone, as a card at the top of the markup view ("The agent asks ·
  2"), which also shows while you only read the PDF. While a question is
  open, the tab's Chat shows a line "The agent asks about …" naming the
  file; **Open** opens it when the agent sent that file to the phone, or —
  with **Project files on the phone** on — when it is a file of the project.
- Each question gets a numbered pin (`?1`, `?2`…) on the page, at the words
  it is about. Tap the pin to find the question, or **Show on page N** to
  find the place.
- Several questions show one at a time: **‹** and **›** turn between them
  (`2 / 4` says where you are), and a pin turns to its question.

Tap an option to pick it, then tap **Send answers** — a tap alone never
answers, so a pen stroke that lands on the card can't. **Send answers** waits
until every question has a pick. **Other…** lets you type
your own answer (tap it again to clear it). **Answer in chat instead** closes the questions so you can
reply in the tab. Your answer is typed into the tab as your next message (it
waits in the queue if the agent is still busy), and the card goes away on
the desktop and the phone. If it could not be sent, the questions stay open
so you can try again.

A newer question from the same tab replaces the open one. The desktop must be
running: with it closed, the phone shows no questions. Remote, VM and
container tabs don't have the tool. It is on by default; turn it off in
Settings → Agents → Manage CLIs, under Advanced: **Let project agents ask
about your PDF marks** (new tabs no longer get the tool; tabs already open
are told it is off when they ask).

## Project files on the phone

Switch on **Project files on the phone** under **Project access** (off by
default) and a project's screen on the phone opens its files when you swipe
from left to right across it, the screen's left edge included — a drawer
slides in from the left (swipe back, or tap beside it, to close it). Inside a
tab's Chat (or a shell tab's Reader) the same swipe opens them when it starts in the left third of
the screen; further right it shows the agent's status line (a shell tab has
none, so there any left→right swipe opens the files). Walk the folders and
open a file —
pictures and text full screen, PDFs in the browser, with Save and Share. It is
read-only: nothing can be changed, moved or deleted from there.

As in the desktop's file tree, the project root's standard files (README,
AGENTS.md, .gitignore, …) fold into a **scaffold** row and what git ignores
folds into a **gitignored** row below the rest of each folder; both start
collapsed — tap one to open it.

- It covers the projects switched on for Mobile, not boxes or the root
  console.
- `.git`, `.tabtivity` and `.env…` are left out, symbolic links are not shown or
  followed, and a folder shows its first 500 entries.
- Files up to 24 MiB open; a longer text file shows its first 24 MiB.
- Switching it off closes the drawer within seconds, without restarting the host.

## Git on the phone

Tap a project's name on the phone and choose **⎇ Git** to see its git state —
or, on the start page, tap the coloured git mark in a project's row ("not
pushed", "not committed", …). It is read-only — nothing is checked out,
switched or created from there:

- The branch the project folder has checked out (or the commit it is
  detached at), its upstream, and how far it is ahead (↑) or behind (↓) as of
  the last fetch, with the same coloured dot as the project list.
- **Worktrees**, when the repo has more than the project folder: the project
  folder first, then each linked worktree with its branch, whether it has
  uncommitted or unpushed work, and how many of the project's tabs run in it.
- **Branches**: the local ones (● marks the checked-out one; "in …" names the
  worktree that has a branch checked out), and, folded away, the remote
  branches no local branch already tracks.

It works with the desktop closed, refreshes when you come back to the app or
tap **↻ Refresh**, and covers projects only, not boxes or the root console.
The ＋ sheet's **Agents start in** row lists the same worktrees.

## Local models from the phone

Home → **Local models** opens the Ollama models installed on the desktop
(help topic `local-models`). Each row shows the model's size, its parameters
and quantization, and whether it is in memory: where (**On the GPU**, **N %
on the GPU**, **On the CPU**) and for how long (**Stays loaded until
unloaded**, or **Unloads in N min**). The model new Local Model tabs use is
marked.

- **Load** puts a model into memory and keeps it there; Ollama decides GPU or
  CPU. The desktop's Models & agents menu shows the load while it runs.
- **Unload** frees the memory at once, without asking.
- With Ollama stopped, **Start Ollama** starts it — only in ways that need no
  password on the desktop. If it was started as Tabtivity's own server,
  quitting Tabtivity stops it again.
- The list refreshes on its own: every few seconds while something loads or
  starts, otherwise every 10 seconds.
- Downloading, updating and deleting models stay on the desktop; the phone
  offers none of them, and the desktop refuses them.
- Loading a single model when none is in memory makes it the model for every
  role (Tabs included), as it does on the desktop.

The desktop window must be open: with Tabtivity closed, the sheet says to open
the app. A Load that takes longer than the phone waits is not reported as
failed — the list is read again and shows whether it started. If it says to
open the app while Tabtivity is open on the desktop, or says to update
Tabtivity there, the desktop's Tabtivity is older than this feature: update and
restart it. It is on by default; switch it off in Settings → Mobile → **Local
models from the phone** (under **Project access**), and the row disappears.

## Notifications on the phone

On the phone, open **This phone → Notifications** (or **Calendar → Reminders**)
and choose what reaches you, even with Tabtivity Mobile closed:

- **Calendar reminders** — each reminder of the desktop calendar. A tap opens
  the Calendar.
- **Agents** — *When one needs your answer* (an agent tab waiting on a
  question or approval), or *Also when one finishes a turn*. A tap opens that
  tab. A tab you have open on the phone right then does not notify, and one
  tab notifies at most every 30 seconds.
- **What a notification shows** — *Names and details* (event title, time and
  place; project and tab), or *Only that something wants you*, for a lock
  screen others can see.

Tabtivity must be running on the desktop: it is what notices the reminder or the
agent's turn.

- This is the one Mobile feature that leaves your tailnet: notifications travel
  through your phone browser's push service (Google, Apple, Mozilla or
  Microsoft). Each one is encrypted to your phone first, so the service cannot
  read it.
- On iPhone, add Tabtivity Mobile to the Home Screen and open it from there;
  Safari tabs cannot receive notifications.
- A calendar whose alerts are switched off on the desktop stays silent on the
  phone too. Revoking a phone stops its notifications at once.
- Only agent tabs of projects (and boxes) the phone may reach notify.

## If the phone won't connect

"Connecting to your workspace…" that never finishes, or a splash saying the
desktop can't be reached or didn't answer, usually means the phone's own
Tailscale is not carrying traffic. The splash lists these steps itself, in the
phone's language:

1. Open the Tailscale app on the phone (on Android the splash has an **Open
   Tailscale** link) and check it is connected.
2. If it already says connected, **force-stop** it — Android: Settings → Apps
   → Tailscale → Force stop — and open it again. After the phone changes
   networks Tailscale can stay "connected" while passing nothing, and its own
   off/on switch does not clear that; a force stop (or restarting the phone)
   does.
3. Still nothing: turn airplane mode on for a few seconds, then off, and
   press Retry.
4. Only one VPN runs at a time on a phone: another VPN app switched on
   silently takes Tailscale's place.
5. Still stuck: check the desktop is awake and Tabtivity is running on it.

To make it rarer on Android, set Tailscale's battery use to **Unrestricted**
and turn on **Always-on VPN** for it (search Settings for "VPN", then tap the
gear next to Tailscale; Samsung lists it under Connections → More connection
settings → VPN).

The splash also shows the phone app's version and build time (`v0.1.x ·
dd-mm hh:mm`), the same line as the home screen's header. After the desktop
updates, a build time older than the desktop's means the phone is still
running an old copy: close and reopen the app.

The desktop keeps the phone's server up to date by itself: each time Tabtivity
starts, a server older than Tabtivity is replaced (phones reconnect within
seconds). If that fails — Tailscale down, say — the old server keeps running
and **Update** in the header's Mobile menu (or **Settings → Mobile → Update
mobile host**) does it by hand; either appears only while the server is behind.
**Reconnect** in that menu restarts the server if it stopped.

## One phone at a time

Under **Settings → Mobile → Paired devices** each phone has its own controls
(the Mobile host must be running):

- **To-do / Calendar / Mail** — press one off to keep that phone out of the
  section. Its tab disappears from the phone, the computer refuses the
  section's requests from that phone, its alert rows leave the phone's Home
  strip, and a phone without Calendar gets no reminder notifications. The
  other phones are not affected.
- **Projects on this phone** — the projects and boxes that phone can open.
  **Disconnect** takes the phone off one. A project open to *all phones*
  then stays open to the other phones paired now (a phone paired later is
  not added); disconnecting the last phone turns the project's Mobile access
  off. **Add project** opens one more for that phone; a project that was off
  opens for that phone alone.

A phone that is paired again counts as a new phone and starts with every
section shown.

## If a phone goes missing

The header's Mobile button shows the host status. **Revoke** drops one device;
**Lock down** forgets every paired device and stops the host. Also remove the
device from your Tailscale machines.

A phone paired again counts as a new phone: projects limited to **Only these
phones** do not include it until you tick it again. After **Lock down** (or
**Forget all devices**) every such project reaches no phone and shows
**No phones ▾** in Mobile settings until you pick its phones again; projects
set to **All phones** reach the newly paired phones as before.
