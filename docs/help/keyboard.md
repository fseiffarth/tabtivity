---
id: keyboard
title: Keyboard shortcuts and Tabtivity navigation
keywords: [keyboard, shortcut, hotkey, keys, tabtivity navigation, steering, chord, rebind, f1, cheat sheet, navigation]
---

Every key below is a default — the Tabtivity navigation keys included. Rebind any
of them in Settings → General → Keyboard Shortcuts: click a key and press the
new one, **×** turns a chord off (or drops one Tabtivity navigation key), Reset brings the
default back, and the panel warns about collisions. On macOS, ⌘ takes the
place of Ctrl. **F1** opens the cheat sheet with every effective binding.

## Window and view

| Default | Action |
|---|---|
| F11 | Toggle fullscreen for the window you're in — the main window, a popout or a presenter window (same as the fullscreen button beside minimize) |
| Super (Linux, when the desktop leaves it to the window) or F9 | Show/hide the side panels. To bind a lone Super tap yourself (Linux only), press and release Super while capturing |
| Esc | Leave a pane's in-app fullscreen (dialogs always close on Esc) |
| Ctrl + / − / 0 | Zoom the interface in / out / reset — in an agent tab its font, in an editor its text |

## Navigation

| Default | Action |
|---|---|
| Ctrl+Shift+Tab | Next project |
| Alt+Shift+← | Previous project |
| Ctrl+Shift+PageDown / PageUp | Next / previous box |
| Ctrl+Shift+R | Open / close the root console |
| Shift+Space | Enter Tabtivity navigation |
| F1 | Shortcut help |

## Tabs and panes

| Default | Action |
|---|---|
| Ctrl+Shift+← / Ctrl+Shift+→ | Previous / next tab in the pane — from a focused terminal too (a program in it then never gets these keys; plain Shift+←/→ is left to it, e.g. an agent CLI's own use of it) |
| Shift+Tab | Cycle tabs in the pane |
| Ctrl+Shift+↑ / Ctrl+Shift+↓ | Cycle pane focus up / down |
| Ctrl+Enter | Toggle the focused pane's fullscreen |
| Shift+F | Toggle the pane's docked file viewer |
| Ctrl+Shift+H | Hide the focused pane |
| Ctrl+W | Close the active tab |
| Ctrl+Shift+W | Close the focused pane |
| Ctrl+Shift+Alt+W | Close all tabs in the project |
| Ctrl+Shift+T | Reopen the last closed agent tab, resuming its conversation (works from a focused terminal; in a popout window it reopens into that window) |

## New tabs

Each opens a tab in the focused pane of the main window and puts the cursor
in it — from a focused terminal too. The + menu shows each chord beside its
entry.

| Default | Action |
|---|---|
| Ctrl+Shift+N | New shell |
| Ctrl+Shift+M | System Monitor (focuses it if the pane's scope already has one) |
| Ctrl+1 | New tab with your default agent (set in the 🧠 menu) |
| Ctrl+2 … Ctrl+9 | The + menu's other agents, in the order it lists them |

To choose which agent each number opens, reorder them with ↑/↓ in
**Settings → Agents → Manage CLIs** (also the 🧠 menu's Manage CLIs…); each installed agent shows
its chord there. Once you have moved one, the list order is the numbering —
Ctrl+1 is the top agent rather than the default one.

Inside the mail, calendar or to-do window, Ctrl+1 … Ctrl+9 open no tab in the
pane underneath: they dock that number's root-console agent in a column beside
the app, numbered as the root console's `+` menu numbers them (only agents with
the **Root** chip). See `mail-calendar`.

## Tabtivity navigation

Press **Shift+Space**. A legend appears at the bottom and the app answers
single keys, even while a terminal has focus. (Mid-word, with Shift still held
from a capital, Shift+Space stays a plain space.) The mode opens on the
current project's tabs; **E S D F** work like **↑ ← ↓ →** throughout.

| Key | Action |
|---|---|
| S F / ← → | Previous / next tab (on the subwindow level: subwindow; on the project level: project) |
| E / ↑ | Up a level: tabs → subwindows → projects → the top bar |
| D / ↓ | Back down a level |
| 1–9 | Tabs: new agent tab. Projects: jump to a station (1 = root, 2 = first pill) |
| N / M | New shell / System Monitor tab (projects: new project / mail) |
| + | The new-tab menu, walked with E/D; **/** types into its search |
| V | Toggle the pane's file viewer |
| W | Close the active tab |
| A | Walk the card over the active tab (Undo clear, a sign-in link) |
| . | The right-click menu of the active tab (projects: of the project; in a panel: of the highlighted row) |
| B | Open the side panel |
| P | Toggle the side panels |
| Q / R / X | Next tab waiting for an answer / working / done (Shift: previous) |
| , | Open Settings and walk it: ← → pages, E D controls |
| ? | Open the cheat sheet: E D scroll it |
| Space / Esc / Enter | Leave Tabtivity navigation (Esc inside a panel or menu backs out of it) |

Dialogs and menus don't end the mode. Whatever comes up on top — a confirm, the
New project dialog, a right-click menu, a top-bar menu, the root console — gets
the highlight: E D go row to row, S F along a row, Enter presses, and Esc closes
it the way its own Escape would. The mode then returns to where the dialog was
opened. On the top bar, S F walk its buttons and D drops a button's menu.
Enter on a text field leaves the mode so you can type there; Shift+Space brings
it back on the same dialog.

Each Tabtivity navigation action takes up to two keys (a letter and its arrow, say),
rebound in the same settings page under *Inside Tabtivity navigation*, one list per
level. A letter can mean one thing on the projects level and another inside a
pane; the legend and the cheat sheet always show the keys you have.

## In editors and viewers

The editor's own keys — Ctrl+F find, Ctrl+R replace, Ctrl+Space
autocomplete, Ctrl+Z / Ctrl+Y undo and redo, Ctrl+S save, Ctrl+Shift+C
comment the lines — are defaults too, in the settings page's *Editor* list.
Keys inside a suggestion, the find bar or a dialog stay as they are.

- **Ctrl+Space** asks the local model for an autocomplete suggestion (when
  autocomplete is on for that file type). Tab accepts it, Alt+→ takes one
  word, Shift+Tab cycles the length (sentence → block → scope), Esc dismisses.
- TeX workspace: Ctrl+Shift+B saves and compiles; Alt+Shift+↑ goes up to the
  parent document; Alt+Shift+↓ goes back to the previous file.

## In terminals

Copy, paste and keyboard select (Ctrl+Shift+C / V / X below) are rebindable
in the settings page's *Terminal* list.

- Click a link to open it in your browser; **double-click** it to copy it to
  the clipboard instead.
- **Select to copy**: drag over text and it is on the clipboard when you let
  go (a toast confirms, or says the clipboard refused it). This works in agent
  tabs too, even while the agent has the mouse. Alt+drag selects a rectangle.
- **Right-click** on selected text copies it and clears the highlight; with
  nothing selected, right-click goes to the program (Claude Code pastes).
- **Ctrl+Shift+C** copies the selection, **Ctrl+Shift+V** pastes (in agent
  tabs a double-click off a link pastes too). Plain Ctrl+C still interrupts
  the program.
- **Ctrl+Shift+X — keyboard select.** A cursor appears on the terminal cursor
  (or on an existing mouse selection) with a legend at the bottom of the pane:
  arrows or h/j/k/l move, Ctrl+←/→ jump by word, Home/End go to the line's
  ends, PageUp/PageDown by a screen, g/G to the top/bottom of the scrollback.
  Hold **Shift** while moving (or press **v**) to select, **V** for whole lines.
  **Enter**, **y** or Ctrl+C copies (with nothing selected: the cursor's line),
  **Esc** or **q** leaves. While it is on, no key reaches the program.
