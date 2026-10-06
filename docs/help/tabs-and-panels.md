---
id: tabs-and-panels
title: Tabs, panes and panels
keywords: [tab, pane, split, subwindow, detach, popout, file panel, file tree, viewer, root console, header, menu, restore]
---

## Add a tab

1. Click the `+` at the right end of any tab bar (every pane has its own).
2. Pick from the menu. The search box at the top filters the whole list;
   ↑/↓ and Enter pick without the mouse.
   - **Agents & CLIs** — installed agent CLIs. A short list shows first
     (Claude, Codex and Gemini by default; the "+ tab" chip in the Models &
     agents menu decides who is on it); **More agents & CLIs…** holds the rest.
   - **Local Model** — agents that drive your on-device Ollama model (see
     `local-models`).
   - **Shell** — a plain terminal in the project folder.
   - **Files** — an in-app file browser.
   - **Monitoring** — System Monitor, Disk Usage, Network Traffic.
   - **Workspace** — Calendar, Printing, the Skills library, and a Browser tab
     when that experimental feature is on.
3. The new tab opens focused in that pane.

Only agents whose CLI is installed are listed. Install missing ones from
Settings → Agents → Manage CLIs (see `agent-clis`).

## Arrange tabs

- Drag a tab left/right in its bar to reorder it.
- Drag a tab onto a pane's top/bottom/left/right edge to split; drop it in the
  middle to move it into that pane.
- Drag a file from the file tree onto a tab bar or pane edge to open it there.
- Drag a tab (or a whole tab bar) out of the window to pop it into its own
  window; drag it back to dock it.
- Right-click a tab for Rename, Duplicate, Close, Close others, and its task.
  Shift+right-click renames inline; double-click also renames.
- Group tabs: right-click a tab → New tab group… (or Add to group “…”). A
  group folds into one chip in the bar; hover the chip to list its tabs and
  click one to open it. Right-click the chip to rename, ungroup or close the
  group. Groups are saved with the layout.
- Mark a tab: right-click → **Important** (`!`) or **Urgent** (`!!`); pick it
  again to clear. The mark shows on the tab, and the project's pill shows the
  most pressing one with a count — click it to jump to that tab. Marks are
  saved with the layout.
- To-do card from a tab (to-do board switched on): right-click → **Create to-do
  card** files a card titled after the tab under its project and opens it. The
  tab then shows ☑ (click to open the card) and the card shows the tab (click
  to go to it). Right-click again to open or unlink the card.

Your layout is saved automatically per project.

## What comes back after a restart

Shell and Files tabs always return. Agent tabs return when their CLI can
resume: Claude, Codex and Mistral reopen their exact prior conversation;
Gemini, Qwen, Grok, Cursor, Copilot, OpenCode and Antigravity continue the
project's most recent one. Agents without a resume path (Aider, for one) start
fresh from the `+` menu. Closing a popped-out window closes its tabs for good.

## The file panel

- Push the cursor to the right edge to reveal it; click the pin to dock it.
  It can be resized and moved to the left edge.
- Views in its header: **Files** (tree with git markers and a context menu),
  **Git** (branches, commits, Git sync), **Search** (file names and contents),
  **Apps** (tracked external windows), and for remote projects the **±** sync
  view, **Sessions** and **Jobs**.
- Double-click a file to open it in Tabtivity's built-in viewers: PDF, LaTeX,
  Markdown, notebooks, YAML/JSON, tables/CSV, SQLite, images, audio/video,
  code and more. Right-click → **Set default app…** sends a type to an
  external application instead.
- The file panel's **Project settings** dialog holds file hiding rules and
  the **Native Viewers** table (per type: use the built-in viewer,
  autocomplete, completion length, spelling).

## Hiding the panels

The panels auto-hide when the pointer leaves. Toggle them all with **Super**
on Linux desktops that leave that key to the window, otherwise **F9**; on
macOS push the cursor to a screen edge. **F11** toggles fullscreen.

## The root console

Ctrl+Shift+R (or the ✦ entry) opens the root console: a floating window over
whatever is open, with its own tabs in Tabtivity's root folder, independent of
any project. Closing it ends nothing. One-click installs open their terminal
tab here. Agents are opt-in in the root console: turn on an agent's **Root**
chip in the Models & agents menu to offer it there; the **MCP** chip also
gives it Tabtivity's root tools (calendar, board, project list). An agent
docked beside the mail, calendar or to-do window is a root-console tab too, and
shows in the console's strip. See `mail-calendar`.

## The Models & agents menu

The chip-icon button in the header hubs local Ollama models (load, unload,
pull, role chips), installed agent CLIs (Default, "+ tab", Root and MCP
chips), **Manage CLIs…**, **Skills library…**, and live CPU/RAM/GPU meters.
Hover it for the quick menu; **click** it for the **Models & agents** window,
which opens on a grid of four tiles, each showing what is there right now —
**Agents & CLIs** (install, update, remove, plus the same chips), **Local
models** (everything the menu shows, full size), **Ollama** (install Ollama,
model storage, downloads, the catalog) and **Skills**. Click a tile (or use
the arrow keys and Enter) to open it; **All sections** in the title bar goes
back. Every entry in the menu opens its section directly; Escape or a click
outside closes the window.
