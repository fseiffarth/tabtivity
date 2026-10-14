---
id: workspace-apps
title: Print manager, skills library, daily recap, system monitor and browser
keywords: [print, printer, print manager, queue, cups, test page, skills, skills library, skill.md, claude skills, recap, daily recap, usage stats, statistics, tokens, time, system monitor, cpu, gpu, memory, disk usage, network, machines, browser, reader mode, live pages, downloads, global apps]
related: [mail-calendar, settings-and-appearance, remote-projects, pdf-and-markup]
---

Some jobs you would otherwise leave Tabtivity for have a small built-in app.
Most open from the tab bar's `+` menu, as a tab of the current project or as an
overlay over the whole window. Mail, the calendar and the to-do board are in
`mail-calendar`.

## Print manager

`+` → **Print Manager** shows every printer this computer knows, its queue,
and the default. **Pause** / **Resume** a printer, cancel a stuck job, send a
**Test page**, or **Make default**. It uses CUPS on Linux and macOS and the
system's printing on Windows; with no print system installed it just says so.
Printing a PDF itself: see `pdf-and-markup`.

## Skills library

The **Skills Library** (in the Models & agents window, or `+`) browses
`SKILL.md` catalogs from git repositories: **Add source…** with a git URL,
then install a skill with one click — into the current project's
`.claude/skills/`, or into your personal skills, which every project's
Claude tabs see. Skills are for Claude Code.

## Daily recap and usage stats

A private summary of your work, counted on this computer only — nothing is
uploaded. It opens on the first start of each day (covering the last day you
worked), with buttons to continue where you left off. **Settings → Workspace &
apps → Usage stats → Open usage stats** opens it any time, and **Show the recap
at the start of each day** switches the automatic opening off.

Pick a **Period** (Day, Week, Month). It shows time per project, **Agents**
(which agents and models you used, prompts asked, how often agents stopped to
ask), **Work** (shell commands, commits), **Files** (created, changed,
deleted), **Rhythm** (your busiest hours) and **Tokens**: the tokens Claude and
Codex used, read from their own records in Tabtivity's agent homes — fresh
input, cache writes and reads, output, per model. Other CLIs show as "not
reported"; there are no cost figures here. Autocomplete accept and dismiss
counts appear too.

## System monitor

The `+` menu's **Monitoring** group has **System Monitor** (CPU, memory and
GPU, per process), **Disk Usage** and **Network Traffic** — for this computer,
or for a connected remote machine (on a remote project, or from a machine's
tile in **Machines**). The header can
also show live CPU, RAM and GPU meters (Settings → System → Resource
monitor).

## Machines

The header's **Machines** indicator lists your SSH machines that belong to no
single project, with their state and a live load bar. Click it for one tile
per machine: connect, check, open its system monitor, see who is logged in
and what runs there, or hand it to a project as a worker or as its host. See
`remote-projects`.

## Browser

Experimental (**In-app browser** in Settings → System → Experimental): `+` →
**Browser** opens a reader-mode tab — text and images, no scripts — with a
start page, downloads, and a chip that warns about disguised addresses.
**Settings → Workspace & apps → Browser** sets the home page, the search
engine and where links open. **Allow live pages** (off by default) opens a real,
script-running page in a separate window with a throwaway profile; a live
page can reach services on this computer, so leave it off unless you need it.
**Open in external browser** is always there.

## Downloads

The file panel can show your download folders: files modified recently, to
drag onto a project folder or copy into the project with →. Add folders under
**Settings → Workspace & apps → Downloads**. Tabtivity never changes another
browser's download settings.

## Global apps

**Settings → Workspace & apps → Global Apps** records one command per role
(for example the browser PDF links open in). These stay visible across
project switches.
