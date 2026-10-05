# Platforms and current limits

Moved out of the [README](../../README.md).

## Platform support

| Platform                  | Status             | Notes                                                                                        |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| **Linux — X11**           | Yes                | Two-desktop workspace parking model (EWMH/xcb). Primary development target.                  |
| **Linux — KDE Wayland**   | Yes                | Per-project virtual desktop model via KWin DBus scripting. KDE 5 and KDE 6 supported.        |
| **Linux — other Wayland** | Partial            | Null backend (no workspace switching, no sticky windows). Terminal and file management work. |
| **Windows**               | Yes (alpha)        | Win32 `SW_HIDE`/`SW_SHOW` parking model (+ best-effort virtual-desktop pinning). Start-Menu app launch with `.lnk`/icon resolution, shell file associations, external-window tracking, OpenVPN, SSH/SFTP remote projects, Claude/Codex agent resume, project containers via Docker Desktop, project VMs via QEMU + WHPX, Tabtivity Mobile (Run-key sidecar), in-app browser live pages (deny-all permission handler), DXGI GPU readouts, and a WebView2 renderer crash reporter. No agent fence (no unprivileged sandbox on Windows), no tmux session persistence, no ControlMaster link counters. CI-verified only. |
| **macOS**                 | Yes (lightly tested) | App-granular window parking via `NSRunningApplication` hide/unhide (no public per-window API), `.app` scanner, LaunchServices file defaults, Keychain, `caffeinate` presenter inhibitor, `sandbox-exec` agent fence, project containers (Docker Desktop), project VMs via QEMU + HVF (arm64 guests on Apple silicon), Tabtivity Mobile (launchd agent), `nettop` SSH-link counters, IOKit GPU readouts. Compiles and tests on the CI macOS runner and runs on real hardware; only lightly tested there so far. |

## Current Limits

- Live window embedding (frameless reparenting of an external app into a tab) is
  not yet implemented; files render in built-in in-app viewers where available,
  otherwise open in the OS default app (`xdg-open` / shell open) and are tracked
  as external windows.
- KDE Wayland workspace management needs live-session QA.
- macOS parks at *application* granularity (hide/unhide the owning app): a
  single window of a multi-window app cannot be parked on its own, and a
  launched app cannot be placed on a chosen monitor (no public API for
  positioning another app's window).
- Terminal/tab layout is persisted per project and box; shell, file-viewer,
  and supported resumable agent tabs restore on relaunch. An ordinary PTY's
  processes and scrollback do not survive an app exit; tmux-backed sessions
  can survive and reattach. Continue-latest agent restores have the multi-tab
  limits described above.
- Detached subwindows re-dock on restart. Closing a detached window closes its
  tabs; it does not dock them back.
- Non-KDE Wayland compositors fall back to the null backend.
- Remaining office formats (`.docx`, `.pptx`, `.ods`, …) have no native viewer
  yet and open in the external default app.
- **Code-complete does not mean live-verified.** Mail and selected calendar,
  to-do, Mobile, import, and monitor controls have recorded live use. That does
  not validate every path in those subsystems: CalDAV server sync, mail crypto,
  the deck presenter, VM boots, SLURM/HPC, and the newest prompt-chart workflows
  still have open acceptance checks. Features awaiting verification carry an
  *untested* pill; it is removed per item after user confirmation.
- Tabtivity Mobile runs its host sidecar on all three desktops (systemd user
  unit, launchd agent, Windows Run key), requires Tailscale on both ends, and
  its real-phone security and acceptance QA is still open.
- Containerized projects are local-only and need Docker (Docker Desktop on
  Windows/macOS, where they have never been run); VM projects need QEMU with
  hardware acceleration (KVM, Hypervisor.framework, or the Windows Hypervisor
  Platform) and have never been booted on any host.
- Windows has no agent fence (there is no unprivileged filesystem sandbox to
  build one on), no tmux-backed local session persistence, and no SSH
  ControlMaster to read link traffic from; each is reported in the UI rather
  than silently skipped.
- The Agent Skills library is Claude-only, with no manifest, versioning, or
  cross-agent generalization — deliberately out of the MVP.

## Vision

Each platform parks windows in its own idiom today (desktops, `SW_HIDE`, app
hide/unhide), and the design is cross-platform by intent. The long-term shape
is a stable Tabtivity core behind pluggable compositor/window backends (X11,
KDE/KWin, Hyprland, GNOME Shell, i3, Sway, and other Wayland environments; the
Win32 backend on Windows; AppKit on macOS), and eventually a Tabtivity-native
compositor for full control of projects, windows, and layout.

See [VISION.md](../VISION.md) for the full strategy and platform rationale.
