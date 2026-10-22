---
id: project-desktop
title: Project desktops — windows, default apps and time tracking
keywords: [desktop, window, windows, park, parking, hide, switch project, virtual desktop, workspace, kde, wayland, x11, gnome, macos, windows, external app, open with, default app, file type apps, apps view, tracked windows, time, time tracking, hours, global apps, sticky, ide, open in ide, pycharm, vs code, jetbrains, android studio]
related: [projects, tabs-and-panels, workspace-apps, settings-and-appearance]
---

A project in Tabtivity owns more than its tabs: the outside windows you open
from it (a PDF reader, a browser, an office document) belong to it too, and
switching projects swaps them as one unit.

## What a project switch does

Click another project pill and:

- that project's tabs, layout and file panel come back;
- the windows that belong to the previous project are **parked** (hidden out
  of the way) and this project's windows come forward;
- file types open in this project's preferred apps;
- time tracking moves to the new project.

Popped-out subwindows of a project park and come back with it too. Global apps
(Settings → Workspace & apps → Global Apps) stay visible in every project.

## How parking works on each system

| System | How windows are parked |
|---|---|
| Linux, X11 | Moved to a second, hidden desktop |
| Linux, KDE Plasma (Wayland) | One virtual desktop per project (KDE 5 and 6) |
| Linux, other Wayland (GNOME, …) | No parking: the compositor does not allow it. Tabs and files work |
| Windows | Hidden and shown again; virtual-desktop pinning where possible |
| macOS | Whole **applications** are hidden and shown: one window of a multi-window app cannot be parked alone |

## Open a project in its IDE

When a project's folder shows that an IDE has been used on it, you can open the
whole project in that IDE: use the code-brackets button in the file panel's
header, or **Open in <IDE>** in the project pill's right-click menu or the file
tree's root menu. Tabtivity recognises:

| In the project folder | Opens in |
|---|---|
| `.idea/` | The JetBrains IDE it belongs to — PyCharm, WebStorm, PhpStorm, CLion, GoLand, RustRover, RubyMine, Rider or IntelliJ IDEA — or Android Studio |
| `.vscode/` or a `*.code-workspace` | Visual Studio Code (also Insiders, VSCodium, Cursor) |
| `.cursor/`, `.windsurf/`, `.zed/` | Cursor, Windsurf, Zed |
| `.vs/` or a `*.sln` | Visual Studio, or Rider |
| `*.xcodeproj` / `*.xcworkspace` | Xcode (macOS) |
| `.project` with `.classpath` or `.settings/` | Eclipse |
| `*.sublime-project`, `*.Rproj`, `.spyproject/` | Sublime Text, RStudio, Spyder |

With one IDE found, the header button opens it straight away; with several, it
lists them. If an IDE is not found on your computer, its row says **(not
found)**: click it to pick the program. Right-click a row (or the button) to
choose a different program. A JetBrains project without its own IDE installed
opens in IntelliJ IDEA when that is installed. The IDE's window counts as one
of the project's windows.

When the IDE already has the project open, the same click brings that window
to the front instead of opening it again. This works on X11 and Windows, and
on a Wayland desktop for IDEs that run through XWayland (JetBrains IDEs and
VS Code do unless set to native Wayland); a native Wayland window cannot be
raised by another app, so there the IDE is only asked to open the project.

## Windows a project opened

Opening a file in an external app (double-click a type Tabtivity has no
viewer for, or **Open with**) records the window as the project's. The file
panel's **Apps** view lists them; un-track one there and Tabtivity stops
parking it with the project.

## Which app opens a file

For a file Tabtivity has no viewer for, the app is chosen in this order: the
project's own choice → **Settings → Workspace & apps → File Type Apps** → your
system's default for the type. **Open with** in the file panel's context menu
picks another once. Tabtivity never changes your system's own defaults.

## Time tracking

While a project is the active one, its time is counted. Hover a project pill
to see today's active time; the daily recap (`workspace-apps`) sums it per day,
week or month. The recorded days
travel with an exported project (`project-transfer`).

## Two projects at once

Put them into a **box**: the box behaves like one project with a shared
desktop, file tree and agent tabs, and you take it apart again later. See
`containers-boxes`.
