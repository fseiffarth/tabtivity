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
   non-container projects are eligible.
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
- A PDF or picture in an agent tab's viewer has **Mark up**: draw on it and
  **Submit** sends the marks to that tab. The view stays open — the sent marks
  dim, a pill says what the agent is doing, you can keep marking (the next
  Submit sends only the new marks), and once the agent is done **Reload PDF**
  shows the rebuilt file under your marks. The sent marks stay until you erase
  them, so you can check each change. The agent first only lists the changes;
  tap **Make these changes** to let it go ahead (both prompts: Home → This
  phone → **Mark up prompt**). The desktop's PDF viewer has the same **Mark up**
  for local projects, with its own prompts in Settings → Agents → **PDF markup**.
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

Tap an option to answer. With several questions, or one that takes more
than one option, pick and then tap **Send answers**. **Other…** lets you type
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

- It covers the projects switched on for Mobile, not boxes or the root
  console.
- `.git`, `.tabtivity` and `.env…` are left out, symbolic links are not shown or
  followed, and a folder shows its first 500 entries.
- Files up to 24 MiB open; a longer text file shows its first 24 MiB.
- Switching it off closes the drawer within seconds, without restarting the host.

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

## If a phone goes missing

The header's Mobile button shows the host status. **Revoke** drops one device;
**Lock down** forgets every paired device and stops the host. Also remove the
device from your Tailscale machines.
