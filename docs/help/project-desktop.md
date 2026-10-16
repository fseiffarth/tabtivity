---
id: project-desktop
title: Project desktops — windows, default apps and time tracking
keywords: [desktop, window, windows, park, parking, hide, switch project, virtual desktop, workspace, kde, wayland, x11, gnome, macos, windows, external app, open with, default app, file type apps, apps view, tracked windows, time, time tracking, hours, global apps, sticky]
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
