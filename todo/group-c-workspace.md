## Group C — Workspace Switching / Platform Stability
*Files: `src-tauri/src/platform/x11.rs`, `wayland_kde.rs`, `null.rs`, `services/window_service.rs`, `services/project_runtime.rs`, `commands/workspace.rs`.*

15. **Securely move opened files/windows to the hidden workspace on switch
    (X11).** Fix the reported issue where files/windows opened in one project
    aren't reliably parked on the hidden desktop when switching. Investigate the
    move-retry logic (x11.rs ~retry 5×30ms) and window registry coverage.

16. **Make X11 workspace switching rock-solid.** Broader hardening of the
    two-desktop parking model — fix all known races/flakiness around
    show/hide/switch. (#15 is a specific symptom of this.)

17. **Preserve window z-order across switches.** Today `show_window` always
    raises to `Above` (x11.rs:120), losing stacking order. Track per-window
    z-order in the window registry/session and restore it on show.

18. **KDE Plasma i3-style workspace mode.** Explore an i3-like tiling/workspace
    behavior on KDE Plasma. Note: KDE Wayland per-window show/hide is currently a
    **no-op** (`wayland_kde.rs:74-80`) and needs KWin scripting first — this is
    research + sizable backend work.

19. **Cross-platform verification: Windows, macOS, KDE Plasma.** Verify the app
    runs and degrades gracefully where workspace backends are absent (null
    backend) and KDE works. Mostly QA + targeted fixes. OS-specific build,
    packaging, and native-window work is tracked separately in Group H (#30/#31).
    - **Premise partly stale:** Windows and macOS no longer fall back to the
      null backend — both have real backends (`platform/mod.rs:117,151`), with
      `null` at `:159` for everything else. So the null-degradation half applies
      only to other targets, and what's left here is KDE plus pure QA.
    - **Parity sweep (2026-09-03, ✅ Built · 🧪 Untested on hardware):** every
      Linux-only arm now has a Windows and macOS twin where the OS allows one.
      Each needs one live check on the real OS; none has been run yet:
      - [ ] 🖐️ Deck presenter keeps the screen awake — `caffeinate` (macOS),
        `SetThreadExecutionState` (Windows) — and releases on Present exit.
      - [ ] 🖐️ Spell check finds LibreOffice's `dict-*` dictionaries (Windows
        `Program Files`, macOS `/Applications/LibreOffice.app`) and
        `%APPDATA%\hunspell`.
      - [ ] 🖐️ macOS popout: a detached subwindow is parked/re-shown on project
        switch (its `NSWindow.windowNumber` is the CGWindowID).
      - [ ] 🖐️ Renderer watchdog: Windows lists `msedgewebview2` processes with
        a private-working-set split; a killed WebView2 renderer is logged to
        `crash.log` and the page reloads; on macOS a killed WebContent process
        reloads and logs.
      - [ ] 🖐️ Network pane: connection table populated on Windows (extended
        TCP/UDP tables) and macOS (`netstat -anv`); macOS SSH-link counters
        via `nettop` advance while an SFTP transfer runs.
      - [ ] 🖐️ GPU readouts: DXGI pools on a non-NVIDIA Windows box; Apple
        silicon unified pool + utilization via `ioreg`.
      - [ ] 🖐️ Boxes on Windows: member junctions appear in the box folder,
        traverse, and are removed (not their targets) when a member leaves.
      - [ ] 🖐️ File defaults: `embed_capability`'s `resolved_exec` names the
        shell association (Windows) / LaunchServices app (macOS).
      - [ ] 🖐️ macOS agent fence: a fenced `claude` cannot write outside the
        project, can write `~/.claude`, gets EPERM on `settings.json`, and
        still logs in.
      - [ ] 🖐️ Windows live browser page: no Edge permission prompt ever
        appears (camera/mic/geolocation requests are denied silently).
      - [ ] 🖐️ Windows project container (Docker Desktop): tabs land at
        `/c/…`, git and file viewers keep reading host bytes, session resume
        records land via the POSIX hook twin.
      - [ ] 🖐️ VM tier: doctor passes with `brew install qemu` (macOS, arm64
        guest on Apple silicon) / the qemu.org installer + WHPX (Windows);
        the built-in seed ISO boots cloud-init; shutdown works over QMP TCP.
      - [ ] 🖐️ Tabtivity Mobile on Windows: the Settings section shows, the Run-key
        sidecar starts, and the PowerShell phone-install handoff prints the URL.

---

20. **GNOME/Wayland first-session fixes (2026-09-07, ✅ Built · 🧪 Untested —
    no Rust toolchain on the host when written, so not even compiled there).**
    The dev box moved from Cinnamon/X11 to GNOME/Wayland; GNOME gets the
    `null` backend (no parking — Mutter has no scripting API), which is
    expected, but four things around it were wrong. Each needs one live check:
    - [ ] 🖐️ Detaching a tab group shows a painted popout immediately — not a
      black window for ~2 s (the X11 title scan used to run to its 20×100 ms
      cap; `platform::x11::session_is_wayland` now skips every
      `_NET_CLIENT_LIST` scan, including `find_window_for_pid`/`find_new_window`
      on app launch, which cost up to 4 s before the Apps view updated).
    - [ ] 🖐️ Deck ▶ Present with a second monitor: the audience window goes
      fullscreen on the *other* monitor (`gtk_window_fullscreen_on_monitor`
      by index; `set_position` is ignored under Wayland, so it used to
      fullscreen next to the main window).
    - [ ] 🖐️ Tab-menu Screenshot with no tool configured opens GNOME's own
      picker (portal, `interactive: true`); the shot reaches the save overlay
      and the clipboard; Escape in the picker stays silent.
    - [ ] 🖐️ Popouts on two monitors of different sizes: unplugging/replugging a
      display and switching projects never shrinks a popout on the larger
      screen to the smaller one's size (positions read back as (0,0) under
      Wayland; the snap and switch-back re-placement now skip themselves).
    - [ ] 🖐️ X11 (Cinnamon/KDE) regression check: all four paths behave as
      before — scans still resolve ids, presenter still lands on the second
      monitor, tools still come before the portal, snap still rescues.

---

21. **Open in <IDE> raises an IDE that already shows the project (2026-10-22,
    ✅ Built · 🧪 Untested).** `commands::ide::open_project_in_ide` first looks
    for the IDE's window on the project (`platform::named_windows`: X11/XWayland
    client list or Windows top-levels, matched by `WM_CLASS`/exe and a title
    part equal to the folder name, `.idea/.name` or the `.code-workspace` stem —
    `ide_detect::window_shows_project`) and raises it (EWMH
    `_NET_ACTIVE_WINDOW`, pager source / `SetForegroundWindow`) instead of
    launching again. Native Wayland windows are out of reach: those still just
    launch. macOS lists no windows, so it launches as before.
    - [ ] 🖐️ PyCharm already open on the project, behind Tabtivity: pill →
      Open in PyCharm brings that window to the front and focuses it; no second
      window, no "PyCharm is ready" notification only.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
    - [ ] 🖐️ Same with VS Code (`.vscode/` project), including a minimized
      window; a VS Code window on *another* folder is left alone and the
      project opens in a new window.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows

22. **GNOME (X11 and Wayland) parks launched apps on the workspace to the right
    (2026-10-26, ✅ Built · 🧪 Untested).** Plan:
    `docs/wayland_app_parking_plan.md`, handoff
    `docs/wayland_app_parking_handoff.md`. Launches carry a marker
    (`TABTIVITY_LAUNCH_ID`) so a row outlives its launcher and finds its
    XWayland window late; GNOME runs on the `x11` backend (desktop 0 = active
    project, desktop 1 = parked) and sets/restores its workspace gsettings;
    the Apps view says which rows a project switch can't hide.
    - [ ] 🖐️ PyCharm via **Open in PyCharm** (cold start): listed in the side
      panel Apps view; switching to another project moves its window to the
      hidden workspace (Ctrl+Alt+→ shows it there), switching back brings it
      back — on the primary and on a secondary monitor.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Same with PyCharm already running (the launcher hands the folder
      to the running instance and exits at once): the row stays listed and
      parks/returns with the project; a raise of an already-open project window
      adds a row too.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] 🖐️ GNOME workspace settings come back after a clean quit
      (`gsettings get org.gnome.mutter dynamic-workspaces`,
      `workspaces-only-on-primary`, `org.gnome.desktop.wm.preferences
      num-workspaces` / `workspace-names` read the same as before the start),
      and after `kill -9` of Tabtivity followed by a restart and a clean quit.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] 🖐️ Cinnamon: its workspace settings are restored after a clean quit
      (never happened before — the restore only ran from `Drop`), and parking
      behaves as before (regression check).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] 🖐️ A native Wayland app opened from the project (e.g. GNOME Text
      Editor) is listed in the Apps view with the muted "Stays on screen …
      only XWayland windows can move" line, and stays on screen on a switch;
      the PyCharm (XWayland) row shows no such line. On KDE Wayland/XFCE the
      list shows the one "This desktop can't hide app windows" line instead.
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] 🖐️ Settings → Layout: the "can't hide other apps' windows" note shows
      only on a desktop that parks nothing (XFCE, KDE Wayland) and names GNOME
      among the supported desktops; nothing on GNOME/Cinnamon/KDE X11.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] 🖐️ Drop a file onto a screen to open it in an external app on
      GNOME/Wayland: the app's window is not moved to a wrong place.
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
