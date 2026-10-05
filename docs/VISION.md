# Tabtivity / Eltron Desktop Strategy Summary

## Core vision

Tabtivity should not be “an app that controls apps.”

It should be a project-centric desktop layer:

> User selects a project → Tabtivity restores the complete project context.

A project owns:

- apps
- windows
- terminals
- files
- Git state
- notes
- AI context
- layout
- tasks

The strong concept is:

> Everything belongs to a project.

---

## Best product model

Use virtual project spaces, not raw desktop workspaces as the mental model.

User-facing model:

Project A appears.
Project B disappears.

Technical implementation can vary per desktop.

---

## Best MVP environment

Start with:

Linux Mint / Cinnamon on X11

Reasons:

- easiest window control
- user already works there
- fastest validation
- suitable for power-user/developer prototype

---

## Best initial hiding mechanism

For Cinnamon X11, prefer:

Parking Workspace

over X11 unmap/hide.

Implementation:

Visible workspace = active project

Hidden/parking workspace = inactive project windows

Switch project:

- move old project windows → parking workspace
- move new project windows → visible workspace
- restore layout
- focus primary window

Avoid dynamically creating/deleting workspaces during switching.

---

## Important architecture

Do not build Tabtivity as an X11 hack.

Build:

Tabtivity Core
- project model
- app launcher
- window registry
- layout state
- project switch logic

Backend adapters
- Cinnamon X11
- KDE/KWin
- Hyprland
- GNOME Shell extension
- i3
- Sway

Expose stable internal commands:

hideProject(projectId)

showProject(projectId)

saveLayout(projectId)

restoreLayout(projectId)

assignWindowToProject(windowId, projectId)

Each backend implements them differently.

---

## Wayland implication

Wayland is becoming standard.

This means:

> Tabtivity should not depend permanently on X11 tools like wmctrl, xdotool, xprop.

On Wayland, Tabtivity must integrate with the compositor:

- KDE → KWin scripting/plugin
- Hyprland → hyprctl / IPC
- GNOME → GNOME Shell extension
- Sway → sway IPC

---

## Best long-term targets

Suggested order:

1. Cinnamon X11 MVP
2. KDE Plasma
3. Hyprland experimental/power-user backend
4. GNOME Shell extension
5. Broader Wayland compositors later

---

## KDE

KDE is promising because:

- large user base
- strong power-user culture
- KWin exposes useful scripting/window APIs
- Wayland future is strong
- easier than GNOME for Tabtivity-style orchestration

---

## Hyprland

Hyprland is not an app; it is a Wayland compositor.

It is promising for Tabtivity because:

- very automation-friendly
- has IPC
- supports workspaces and special workspaces
- good for advanced prototype/testing

But it is less mainstream than KDE/GNOME.

---

## GNOME

GNOME Wayland is harder.

Normal apps cannot control other apps’ windows.

Tabtivity would need a GNOME Shell extension, meaning JavaScript code running inside GNOME Shell/Mutter with access to window/workspace APIs.

---

## i3

i3 is also a good technical fit:

- X11-based
- scriptable
- IPC available
- developer/power-user audience

---

## Own compositor idea

Tabtivity could eventually become its own Wayland compositor:

Apps
↓
Wayland
↓
Tabtivity Compositor
↓
Linux

This would give full control over:

- projects
- windows
- layouts
- visibility
- AI context
- workflow orchestration

But it should not be the MVP.

Possible long-term bases:

- wlroots
- Smithay
- Mir
- Hyprland fork/plugin
- KWin plugin/fork

---

## Similarities to existing tools

Existing tools cover pieces of the idea:

- Raycast / Alfred → app launching
- tmux → session restoration
- i3 / Hyprland → window orchestration
- VS Code Workspaces → project grouping

But none combine:

- project ownership of apps
- project ownership of windows
- desktop-wide context restoration
- AI-native workflows

The closest description is:

> A project-centric desktop operating layer.

Tools that claim overlapping ground — including PandaOS, which pitches nearly
the same first pillar — are assessed in
[competitive_landscape.md](competitive_landscape.md).

---

## Strategic conclusion

Do not define Tabtivity as a window controller.

Define it as:

> A project-centric desktop / project OS layer.

MVP:

Cinnamon X11
+ Parking Workspace
+ Project Registry
+ App Launcher
+ Layout Restore

Long-term:

Compositor-integrated project desktop.

Ultimate vision:

> The user does not open applications.
>
> The user opens projects.
>
> Tabtivity restores the entire working context automatically.
