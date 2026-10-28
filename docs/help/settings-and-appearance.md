---
id: settings-and-appearance
title: Settings, themes, performance and updates
keywords: [settings, preferences, theme, dark, light, colors, customize, language, zoom, clock, fast mode, energy saver, battery, unload tabs, memory, scrollback, resource monitor, cpu, gpu, experimental, debug, webgl, gpu compositing, updates, update, version, tour, lessons, hints, untested]
related: [getting-started, keyboard, troubleshooting, files-and-viewers]
---

Open Settings with the gear in the project bar. The left column groups the
pages: **General**, **Workspace & apps**, **Agents**, **Remote & mobile** and
**System**; **Search settings…** at the top finds any setting by name.

## Where things are

| Group | Pages |
|---|---|
| General | General (theme, language), Layout, Clock, Hints & onboarding, Keyboard Shortcuts, Updates, Feature Guide |
| Workspace & apps | Global Apps, File Type Apps, Downloads, Browser, Calendar, Usage stats, Archived Projects, Repair Project Scaffold |
| Agents | Manage CLIs, Ollama Models, PDF markup, Root console and MCPs |
| Remote & mobile | Remote features, Git Hosting, Remote Connections, VPN Auto-Connect, Virtual machines, Mobile |
| System | Power & performance, Resource monitor, Experimental |

## Theme and colours

**Settings → General → Theme**: System (follow OS), Fancy Dark, Soft Dark,
Plain Dark, Plain Light, Fancy Light or Light Lavender. **Theme colors →
Customize…** opens the theme customizer in its own window: recolour any
colour of the interface and the corner style; your changes apply on top of
every theme until you **Reset all**. **Saved themes** keeps named looks (base
theme, accent, colours and corners) to **Load** later.

## Language, zoom and clock

- **Language**: English, Deutsch, Español, Français or Italiano. Text not yet
  translated shows in English.
- **Layout → Window zoom** scales the whole interface; the minimum subwindow
  width and height decide when a split gets too small.
- **Clock**: seconds, and a 24-hour clock (unset, it follows your system).

## Power & performance

- **Energy saver** (Off, On battery, Always) slows background timers and
  pauses idle animation.
- **Fast mode** turns off extras that cost work: folder sizes in the file
  tree, the git dots on project pills, hover cards, the CPU/RAM readout, the
  Python ▶ check, the periodic re-check of remote files and animations.
  Nothing is lost; the extras are simply not shown. Use it on a slow disk, a
  busy machine or a thin network link. It combines with Energy saver.
- **Unload hidden tabs after** a number of minutes frees the memory of tabs
  you have not looked at. They reload where you left off; terminals and agents
  keep running, and tabs with unsaved work, a running build or playing media
  stay loaded.
- **Shell scrollback** sets how many lines each shell keeps (agent tabs keep a
  fixed amount).
- **What open tabs hold** estimates each tab's memory, largest first; **Show**
  jumps to one.

**Resource monitor** chooses whether the header shows CPU, RAM and GPU use
(all three are off until you switch them on), and can collapse the header's
status indicators.

## Experimental

**Settings → System → Experimental** holds features still in progress; each
stays off until you tick it: **Mail client**, **In-app browser**, **Deck
presenter**, **Python Run/Debug in the code viewer**, **GitHub Copilot
autocomplete**, **Markdown link graph**, **Project file remarks**, **WebGL
terminal renderer** (faster terminals; turn off on flicker or missing text)
and **GPU compositing** (smoother scrolling after a restart; turn off on
flicker or crashes). **Debug mode** only adds developer actions to project
settings.

## Updates

**Settings → General → Updates → Check now** looks for a newer release on
GitHub — only when you ask; Tabtivity never checks in the background.
**Download**, then **Install**; your tabs stay open and you restart when it
suits you. A copy installed from the `.deb` (or another package manager)
downloads the new build but leaves installing it to you. The page also lists
anything still found under Tabtivity's old name (Eldrun).

## Learning Tabtivity

**Hints & onboarding** has **How to start...**, the guided **tour** and about
thirty **Lessons** that walk you through real tasks in the real interface
(adding a project, arranging tabs, the PDF and YAML viewers, TeX, printing,
the calendar, mail, local models, boxes, containers, SSH projects, Mobile and
more). **Show contextual hints** and **Reset hints** control the small tips.
Each tip has **Turn off hints** (this switch turns them on again), **Skip**
(closes it for now, its chance unchanged) and **Read**:
every Read halves that tip's chance of showing again, until **Reset hints**
brings them all back. On the phone the same buttons sit on each tip card, and
**This device → Tips** turns tips on again or resets them.
**Feature Guide** is a glossary of the interface.

New features that have not been checked by hand yet wear an **untested** pill;
**Show untested tags** in General hides them.

## Where settings are stored

Tabtivity's own settings are in `settings.json` in its state folder (see
`troubleshooting`). Tabtivity never changes another app's settings.
