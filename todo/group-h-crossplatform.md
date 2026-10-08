## Group H — Cross-Platform: Windows & macOS Support (new feature)
*Files: `src-tauri/src/platform/*`, `services/`,
`terminal/` (PTY), `commands/` (downloads, crash logging), `src-tauri/tauri.conf.json`
(bundle targets), `.github/workflows/ci-cd.yml` (package jobs). Both OSes already
have cross-platform foundations — platform-aware state paths, default-shell
fallback, browser profile paths, network detection — so this is follow-up work,
not a from-scratch port. Builds on / supersedes the OS half of #19 (Group C).*

*Intentional gaps (decided, not forgotten — do not re-open without new facts):*
- *Windows:* `make_sticky` (no public show-on-all-desktops API), window
  **embedding** (no safe cross-process reparenting), ControlMaster and with it
  the ssh-link monitor + `net_usage` sampler (Win32-OpenSSH has no mux support).
- *macOS:* window **embedding** (impossible), **per-window** parking of foreign
  apps (only app-granularity `NSRunningApplication hide/unhide`; per-window needs
  private CGS/SkyLight APIs — rejected as build-fragile), popout self-parking
  (hiding our own app would hide the MAIN window — deferred), `make_sticky`
  (no public Spaces API), system-monitor process table limited to the calling
  user's processes when unprivileged (`proc_pidinfo` visibility).
- *Both:* the network pane's per-connection table (interfaces only; an
  explanatory warning is shown in the pane).

30. **Windows support follow-ups.** Windows is past the compile stage (state
    paths, shell fallback, browser profiles, network detection, app-icon
    helpers, NSIS packaging, and a Windows CI package job all exist). Native
    window tracking/parking (`EnumWindows` + SW_HIDE model, `windows.rs` +
    pure `windows_park.rs`), the PID liveness API (30c), and the
    unhandled-exception crash hook (30g) are all built now. Remaining:
    validate a real build/runtime on Win 10 1903+ and Win 11 (incl. ConPTY
    behavior in xterm.js). (Browser download-preference editing was removed —
    Tabtivity no longer touches any browser's download path; see #60.)

    **Cross-platform detection audit (2026-06-27).** A sweep for Linux-only code
    paths that broke on Windows, fixing the directly-portable ones and tracking
    the rest as the sub-items below.
    - [x] **30a — Cross-platform binary detection.** ✅ Done. Every "is this CLI
      installed?" probe hardcoded `Command::new("which")`, which does not exist on
      Windows, so all agents (Claude included), the TeX toolchain, `sshfs`,
      `sshpass`, and `openvpn`/`pkexec` reported as missing. Centralized one
      `crate::paths::binary_on_path` (`where` on Windows, `which` elsewhere, via
      `paths::path_finder(OsKind)`); `commands/agents.rs`, `commands/tex.rs`,
      `commands/ollama.rs`, `services/ssh_mount.rs`, `services/openvpn.rs` all
      route through it. Agent extra-path fallback also matches Windows exe
      extensions (`.exe`/`.cmd`/`.bat`/`.ps1`).
      - [x] 🤖 Automated test — `paths::path_finder_is_where_on_windows_which_elsewhere`
      - [ ] 🖐️ Manual test — "Manage agents" lists installed agents on Windows
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30b — Cross-platform per-process CPU/RSS sampling.** ✅ Done. `sysstat`
      was entirely `#![cfg(target_os = "linux")]`, so `project_cpu_percent` and
      `debug_app_resource_usage` returned 0 on Windows. Refactored into a shared
      cache/BFS layer over a per-OS backend: Linux `/proc`, **Windows** ToolHelp
      snapshot (`CreateToolhelp32Snapshot`) for the process tree +
      `GetProcessTimes` (kernel+user, 100-ns units) + `GetProcessMemoryInfo`
      (working set), and a zero fallback for other OSes. CPU "ticks"/`clk_tck()`
      abstraction keeps the caller's `busy_secs = ticks / clk_tck()` formula valid
      on every backend. Added `Win32_System_{Diagnostics_ToolHelp,ProcessStatus,
      Threading}` to the `windows` crate features. `terminal.rs`/`debug.rs` no
      longer gate on Linux.
      - [x] 🤖 Automated test — `sysstat` tests now run on Windows too
        (`sum_jiffies`/`sum_rss_kib` against the live process, tree walk, cache)
      - [ ] 🖐️ Manual test — pill popup shows live CPU/RSS on Windows
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30c — Native PID liveness.** ✅ Done. `check_pid_alive`
      (`commands/apps.rs`) no longer shells out to `tasklist` on Windows; it uses
      `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess`,
      treating `STILL_ACTIVE` (259) as alive (a handle to an exited process still
      opens, so the exit code must be inspected — not just OpenProcess success).
      Linux `/proc` and macOS/Unix `kill(pid,0)` branches unchanged.
      - [x] 🤖 Automated test — covered by `cargo build --lib` compile + existing
        callers; no behavioral unit test (needs a live pid)
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30d — App discovery + launching on Windows.** ✅ Done. Linux XDG
      `.desktop` discovery is gated behind `cfg(not(windows))`; Windows now enumerates
      Start-Menu `.lnk` shortcuts (`%ProgramData%` + `%APPDATA%`, recursive, deduped
      by resolved target) for `list_installed_apps`, resolves targets/icons via the
      existing `IShellLinkW` scaffold, and `run_script_detached` runs `.ps1` via
      `powershell -NoProfile -ExecutionPolicy Bypass -File` and `.bat`/`.cmd`/assoc
      via `cmd /C` instead of `bash`. Launch/open/embed commands keep their
      signatures. Degrades gracefully: `xdg-mime` handler resolution no-ops (falls
      back to configured/explicit handlers), icon rasterization is best-effort, and
      `os_embeddable` is false (no Windows embedding backend yet).
      - [x] 🤖 Automated test — `cargo test --lib apps` (incl. a Windows-gated
        interpreter-selection test) passes
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30e — Screenshot capture on Windows.** ✅ Done. `commands/screenshot.rs`
      refactored to a cfg-selected `platform` submodule (Linux tool-spawn unchanged).
      Windows uses native Win32 GDI — `GetSystemMetrics(SM_*VIRTUALSCREEN)` for the
      full multi-monitor virtual screen, `GetDC`/`CreateCompatibleDC`/`BitBlt`/
      `GetDIBits`, BGRA→RGBA, then PNG-encoded via the existing `png` crate to a
      timestamped file (same public command + output dir as Linux). All GDI handles
      freed on success and error paths. Added `Win32_Graphics_Gdi`.
      - [x] 🤖 Automated test — shared filename/date tests retained; build verified
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30f — VPN-gated projects on Windows.** ✅ Done — and since upgraded
      twice: first from the original graceful-degradation stub to a **real
      backend** (direct `openvpn.exe` spawn — worked only from an elevated
      Tabtivity), then (2026-07-16) to an **unelevated interactive-service flow**:
      `connect_streaming` now asks `OpenVPNServiceInteractive` over
      `\\.\pipe\openvpn\service` first (UTF-16LE startup message; the SYSTEM
      service spawns `openvpn.exe` with the user's token and does the
      privileged adapter/route work itself via `--msg-channel`), readiness is
      tailed from `--log` via the shared `wait_for_ready_logfile`, and teardown
      is a user-level `taskkill` + dropping the control pipe (the service
      reverts routes via its undo lists — and kills the tunnel if Tabtivity dies,
      so it can't outlive the app). Non-admins need one-time membership in the
      "OpenVPN Administrators" local group (the refusal message says exactly
      that, with the `net localgroup` one-liner); the direct spawn remains only
      as fallback when the service is missing. Windows `disconnect` also gained
      the `disconnect_interactive` call Linux/macOS always had. Linux pkexec
      path unchanged.
      - [x] 🤖 Automated test — `cargo test --lib openvpn` passes on Windows
        (svc startup-message encoding, reply parsing, cmdline quoting)
      - [ ] 🖐️ Manual test — connect a VPN-gated project from an *unelevated*
        Tabtivity with `OpenVPNServiceInteractive` running (expect the group-
        membership refusal first if not in "OpenVPN Administrators")
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30g — Windows crash hook** (2026-07-11; ✅ Done · 🧪 CI-unverified).
      The native-fault analog of the Unix signal handlers: `install_seh_filter`
      (`lib.rs`) opens crash.log at startup, keeps the raw HANDLE in
      `CRASH_LOG_HANDLE`, and registers a `SetUnhandledExceptionFilter` that
      `WriteFile`s one `=== CRASH: code=0x… addr=0x… ===` line before returning
      `EXCEPTION_CONTINUE_SEARCH`. Formatting is allocation-free via the
      un-gated `format_crash_line` (the heap may be corrupt mid-crash). Added
      `Win32_System_{Diagnostics_Debug,IO,Kernel}` features.
      - [x] 🤖 Automated test — `format_crash_line_*` (4 tests, run on Linux)
      - [ ] 🖐️ Manual test — force a native crash on Windows; crash.log gains a
        `=== CRASH:` line with the exception code
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30h — Windows whole-system monitor** (2026-07-11; ✅ Done · 🧪
      CI-unverified). `sysstat.rs` Windows backend fills a real
      `SystemSnapshot`: aggregate CPU via `GetSystemTimes` (kernel includes
      idle), per-core via a manual `NtQuerySystemInformation(8)` extern decoded
      by the pure `parse_processor_perf_buffer`, memory/swap via
      `GlobalMemoryStatusEx` (swap = pagefile − physical, saturating),
      `GetTickCount64` uptime, one ToolHelp walk for the process table
      (`decode_ansi_nul` for names). All CPU counters stay 100-ns units so the
      frontend's per-process ÷ machine tick math keeps matching units; no load
      average on Windows (`[0.0; 3]`).
      - [x] 🤖 Automated test — `parse_processor_perf_buffer_*`,
        `decode_ansi_nul_*` (run on Linux)
      - [ ] 🖐️ Manual test — System Monitor pane shows live CPU/mem/processes
        on Windows
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30i — Windows local network snapshot** (2026-07-11; ✅ Done · 🧪
      CI-unverified). `commands/network.rs` Windows `local_snapshot` via
      `GetIfTable2`: alias name (UTF-16, `utf16_nul_to_string`), octet
      counters, `OperStatus == Up`, ifType 24 = loopback; empty-alias filter
      rows skipped. Per-connection details stay `None` with a pane warning.
      The ssh-link monitor + `net_usage` sampler stay OFF on Windows by design
      (no ControlMaster mux — see the intentional-gaps register above).
      - [x] 🤖 Automated test — `utf16_alias_decoding_stops_at_nul` (Linux-run)
      - [ ] 🖐️ Manual test — Network pane lists adapters with live byte counts
        on Windows
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30j — Windows SSH password auth via askpass** (2026-07-11; ✅ Done ·
      🧪 CI-unverified). Password auth no longer hard-requires `sshpass`: when
      the installed OpenSSH honors `SSH_ASKPASS_REQUIRE` (≥ 8.4 —
      `parse_openssh_version` + `version_supports_askpass_require`, probed once
      via `ssh -V` in `ssh_supports_askpass`), Tabtivity writes an
      `ap-{pid}-{seq}.cmd` shim that echoes the secret through **PowerShell**
      from the child-only `TABTIVITY_ASKPASS` env var (never `@echo %VAR%` — cmd
      would re-parse `& | < > ^` in a password). Win10-inbox OpenSSH 8.1 falls
      back to `sshpass`; with neither, a clear "needs OpenSSH 8.4+ or sshpass"
      error. All three password branches (probe, one-shot SFTP, pooled master)
      chain askpass → sshpass → error; `SshTooling.password_auth` and the
      dialog warning updated.
      - [x] 🤖 Automated test — `parses_openssh_version_banners`,
        `askpass_require_needs_openssh_8_4`,
        `windows_askpass_shim_echoes_env_without_cmd_interpolation` (Linux-run)
      - [ ] 🖐️ Manual test — password-SSH project connects without sshpass on
        Win11 (OpenSSH ≥ 8.4) and via sshpass on Win10 1903
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30k — Windows position_window + popout occlusion** (2026-07-11; ✅
      Done · 🧪 CI-unverified). `platform/windows.rs` overrides
      `position_window` (`SetWindowPos` with `SWP_NOSIZE|SWP_NOZORDER|
      SWP_NOACTIVATE`) so a file-drop-launched app lands on the drop monitor,
      and adds `frontmost_window_under_cursor` (`GetCursorPos` →
      `WindowFromPoint` → `GA_ROOT`) wired into `detached_window_frontmost` so
      an occluded popout refuses a drop-merge (#42 parity with X11).
      - [x] 🤖 Automated test — compile-gated (`cargo check --target
        x86_64-pc-windows-msvc`); the pure occlusion logic is X11/macOS-side
      - [ ] 🖐️ Manual test — file drop places the app on the drop monitor; a
        popout behind the main window refuses the drop-merge
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

    - [x] **30l — Windows panel-toggle key: F9, not the Win key** (2026-07-15;
      ✅ Done). The lone-Meta panel toggle was enabled on Windows, but the lone
      Win key belongs to the OS: Start opens on key *release* at the shell
      level (`preventDefault()` can't stop it), and every global Win+X shortcut
      pressed while Tabtivity is focused fired a lone "Meta" keydown first,
      spuriously toggling the panels. Lone Super is now Linux-only; Windows
      uses **F9** (`useKeyboard.ts`), and the onboarding/help copy
      (`hints.ts PANEL_TOGGLE_KEY`, `SettingsPanel.tsx`) says so.
      - [x] 🤖 Automated test — existing shortcut tests unaffected; behavior is
        a fixed key branch
      - [ ] 🖐️ Manual test — F9 toggles panels on Windows; Win+X no longer
        flickers them
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30m — Windows one-click agent install** (2026-07-15; ✅ Done).
      `install_agent` hard-refused off Linux/macOS even though the registry
      already carried `install_cmd_windows` for most agents. Now
      `installer_command` picks the interpreter per command — PowerShell for
      `irm … | iex`, `cmd /C` for plain npm/python lines (which may chain with
      `&&`; Windows PowerShell 5.1 doesn't parse that) — with stdout+stderr
      merged in-shell as on Linux. The Manage Agents panel shows the Install
      button whenever the platform has a one-line installer (was `!IS_WINDOWS`);
      agents without one (Mistral/vibe, Cursor) keep the docs-link fallback.
      - [x] 🤖 Automated test —
        `windows_installer_command_picks_interpreter_per_command` (Windows-run)
      - [ ] 🖐️ Manual test — one-click install of an agent on Windows streams
        its log and flips to "installed"
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30n — Windows disk-capacity probe** (2026-07-15; ✅ Done).
      `duscan::capacity_of` returned `None` on Windows, silently dropping the
      disk-usage pane's total/free capacity bar. Added a `#[cfg(windows)]` arm
      via `GetDiskFreeSpaceExW` (total + caller-available bytes, quota-aware —
      matching the Unix `f_blocks`/`f_bavail` semantics).
      - [x] 🤖 Automated test — `capacity_of_home_reports_a_plausible_volume`
        (runs on every OS)
      - [ ] 🖐️ Manual test — disk-usage pane shows the capacity bar on Windows
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **30o — no docker spawn at Windows startup** (2026-07-15; ✅ Done).
      Containers are Unix-only, but `sandbox::sweep_orphans` ran unconditionally
      at startup, spawning `docker --version` (and `docker ps` when Docker
      Desktop exists) for nothing on Windows. Now gated on `cfg!(unix)`.
      **Superseded 2026-09-16 by 32a:** the premise went stale when the
      2026-09-03 parity sweep gave containers a Windows path — `up()` has had no
      OS gate since, so the `cfg!(unix)` guard left crashed-Tabtivity containers
      running. The no-spawn intent is preserved by gating on
      `binary_on_path("docker")`, which walks PATH without spawning.
      - [x] 🤖 Automated test — compile-covered; behavior is an early return
      - [ ] 🖐️ Manual test — n/a
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

31. **macOS support follow-ups.** macOS has initial cross-platform code (state
    paths, default shell, browser profiles, network detection, Unix symlinks),
    and native window tracking/parking now exists (31b — `CGWindowList` +
    `NSRunningApplication`, no Accessibility permission, no private APIs; it
    replaced the null-backend fallback). Remaining: add bundle support when
    distribution is needed (`dmg`/`app` target, `minimumSystemVersion`, CI
    artifact handling); add Hardened Runtime entitlements **only** if
    signing/notarization is pursued — do **not** enable App Sandbox (PTY needs
    unrestricted POSIX PTY access); validate a real build on Apple Silicon (and
    Intel if needed); add native app-icon resolution for `.app` bundles if the UI
    needs resolved macOS icons.
    - [~] **31a — Native CPU/RSS sampling backend.** ✅ Code-complete, ⚠️
      **unverified** (compiles only on macOS; written/reviewed on a Windows host).
      Added a `#[cfg(target_os = "macos")] mod platform` in `sysstat.rs` using
      libproc: `proc_pidinfo(PROC_PIDTASKINFO)` → `pti_total_user + pti_total_system`
      (nanoseconds; `clk_tck()` = 1e9) and `pti_resident_size` for RSS;
      `proc_pidinfo(PROC_PIDTBSDINFO)` → `pbi_ppid`; `proc_listallpids` for the tree.
      Fallback cfg narrowed to `not(any(linux, windows, macos))`. Callers
      (`terminal.rs`/`debug.rs`/`terminal/mod.rs`) are already cross-platform.
      - [ ] 🤖 Automated test — `sysstat` tests run on macOS (currently only
        compile-verifiable on a mac); no macOS CI yet
      - [ ] 🖐️ Manual test — needs a real macOS build to confirm the libc bindings
        (`proc_taskinfo`/`proc_bsdinfo`/`proc_listallpids`) resolve in pinned
        `libc 0.2`; if any is absent, add a minimal `extern "C"`/`#[repr(C)]` decl.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [~] **31b — macOS workspace backend** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified** — compile-blind on Linux, no macOS SDK). macOS no longer
      falls to `NullBackend`: `platform/macos.rs` implements `WorkspaceBackend`
      over raw `extern "C"` FFI — `CGWindowListCopyWindowInfo` enumeration
      (id/pid/owner/layer/bounds need **no** Screen Recording permission) +
      `objc_msgSend` into `NSRunningApplication hide/unhide` (**no**
      Accessibility permission). Parking is **app-granularity** (per-window
      needs private CGS — rejected; see gaps register). Safety invariants:
      `pid == self` unconditionally never hidden (hide is app-wide → would take
      the MAIN window), protected owners (Dock/Finder/WindowServer/…) never
      hidden, cleanup/Drop unhides exactly what was hidden. Hidden apps leave
      the on-screen list, so hide time records window→pid in the pure, un-gated
      `macos_park::MacParkState`. Wiring: factory arm, `apps.rs` window
      resolvers (+ hide-time re-resolve on macOS like Windows), subwindow
      occlusion arm (popouts don't learn a CGWindowID yet), `lib.rs` binds the
      main window's `windowNumber`.
      - [x] 🤖 Automated test — full `macos_park` suite runs on Linux
        (protected-name matrix, structural main-window guard, park/show pid
        round-trip, `frontmost_at_point` occlusion cases)
      - [ ] 🖐️ Manual test — on a mac: project switch hides/shows foreign apps;
        Tabtivity/Finder/Dock never hidden; quitting Tabtivity unhides everything
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [~] **31c — macOS whole-system monitor** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified**, compile-blind). `sysstat.rs` macOS `system_snapshot`:
      per-core CPU via `host_processor_info` (ticks → **nanoseconds** so units
      match the ns-based per-process times; pure
      `parse_host_processor_ticks`), memory via `sysctl(HW_MEMSIZE)` + a manual
      `repr(C)` `vm_statistics64` head (`available ≈ free+inactive`), swap via
      `VM_SWAPUSAGE`, `getloadavg`, boot-time uptime; process table from
      libproc with `bsd_process_state` (SRUN/SSLEEP/SSTOP/SZOMB → R/S/T/Z).
      Unprivileged `proc_pidinfo` only sees the calling user's processes —
      inaccessible pids are skipped (see gaps register).
      - [x] 🤖 Automated test — `parse_host_processor_ticks_*`,
        `bsd_process_state_*` (Linux-run)
      - [ ] 🖐️ Manual test — System Monitor pane populates on a mac; CPU% of a
        busy process roughly matches Activity Monitor
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [~] **31d — macOS local network snapshot** (2026-07-11; ✅ Code-complete,
      ⚠️ **unverified**, compile-blind). `network.rs` spawns `netstat -ibn`
      (chosen over the raw `NET_RT_IFLIST2` sysctl — hand-declared
      route-message layouts are silent-garbage risk when nothing can be run)
      parsed by the fixture-tested `parse_netstat_ibn` (`<Link#N>` rows only,
      end-indexed columns since the Address cell can be empty). Connections
      stay `None` with a pane warning, mirroring Windows.
      - [x] 🤖 Automated test — `parses_netstat_ibn_link_rows` (Linux-run,
        real-shaped fixture)
      - [ ] 🖐️ Manual test — Network pane lists en0/lo0/utun* with live byte
        counts on a mac
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [~] **31e — macOS OpenVPN backend** (2026-07-11; ✅ Code-complete, ⚠️
      **unverified**, compile-blind). Replaces the "not yet supported" stubs:
      `osascript -e 'do shell script … with administrator privileges'` starts
      `openvpn --daemon --log <file>` (osascript blocks until the launched
      command exits — daemonizing is what makes it return), then the handshake
      is followed by tailing the logfile via the cfg-free, temp-file-tested
      `wait_for_ready_logfile`. A macOS-own registry keys config →
      pidfile/logfile (no Child); `is_connected` probes `kill(pid, 0)` with
      **EPERM = alive** (root daemon — this fixes the 28l "lamp never green"
      gap). Disconnect = admin-prompted `kill -TERM` (second prompt accepted
      for v1; management-interface teardown is the no-prompt follow-up).
      Interactive mode types `sudo openvpn --config … --auth-nocache`.
      - [x] 🤖 Automated test — `applescript_escape_*`,
        `macos_admin_shell_command_*`, `pidfile_pid_*`,
        `wait_for_ready_logfile_*` (Linux-run)
      - [ ] 🖐️ Manual test — VPN project on a mac: admin prompt → lamp green →
        disconnect (second prompt) → lamp red; interactive mode types
        `sudo openvpn …` into the root tab
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [ ] **31f — macOS ssh-link traffic via nettop** (design note, no code).
      ControlMaster exists on macOS, so remote projects mux fine; what's
      missing is per-socket byte counters for the ssh-link monitor +
      `net_usage` sampler (`ss -ti` is Linux-only). Design: resolve the master
      pid from `ssh -O check` (as on Linux), then sample
      `nettop -P -x -L 1 -p <master-pid>` and parse its CSV (`bytes_in`/
      `bytes_out` columns) into the existing `SshLinkSnapshot`. Needs a mac to
      verify nettop's CSV shape/permissions before writing the parser.

32. **OS parity sweep (2026-09-16).** ✅ Code-complete, ⚠️ **none of it
    verified live** — deferred items are listed under 32z below. Every item below
    passed `cargo test`, clippy, the Windows cross-check (25 → 0 warnings),
    `npm run build`/`test`/`lint`.
    - [x] **32a — orphan containers swept on Windows.** The startup sweep
      skipped Windows on a premise that went stale (see 30o); now gated on
      `binary_on_path("docker")`.
      - [x] 🤖 Automated test — `sweep_should_probe`
      - [ ] 🖐️ Manual test — kill Tabtivity from Task Manager with a container up,
        relaunch, `docker ps` shows no `tabtivity-*`
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32b — image build uses the platform shell and quoting.** The
      one-click build ran `/bin/bash` on Windows; `default` would have been
      cmd.exe, which ignores `'…'`. Now PowerShell plus `install_shell_quote`
      (apostrophes were broken on POSIX too).
      - [x] 🤖 Automated test — `install_shell_quote` table, `containerBuildShell`
      - [ ] 🖐️ Manual test — project path with a space and an apostrophe →
        build image → PowerShell tab, build succeeds
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32c — copy+delete only on a real cross-device rename.** Any rename
      error triggered the fallback, so a locked file on Windows could leave a
      duplicated, half-deleted tree. `paths::is_cross_device` (never compares
      raw codes across OSes); `move_tree` keeps `|| dst.exists()` so an
      interrupted archive still resumes.
      - [x] 🤖 Automated test — predicate per-cfg tests, `move_tree` tempdir resume
      - [ ] 🖐️ Manual test — Windows: keep a file in a folder open, move the
        folder — an error, and no duplicate at the destination
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32d — saved downloads marked as from the internet.** Mail
      attachments and browser downloads carried no provenance:
      `web_safety::mark_downloaded` writes `Zone.Identifier` on Windows (only
      when absent, so an engine-written mark is kept) and
      `com.apple.quarantine` on macOS. Best-effort, never fatal, no new
      path-taking command.
      - [x] 🤖 Automated test — body/xattr value format; `no_command_takes_a_path`
      - [ ] 🖐️ Manual test — Windows: Explorer shows "Unblock", Office opens it
        in Protected View. macOS: a saved `.command` triggers Gatekeeper
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32e — the phone's sidecar finds tmux.** It spawned bare `tmux`
      without Tabtivity's augmented PATH, so a Homebrew tmux was invisible and the
      phone's tab list came back empty. The attach keeps its `CommandBuilder`
      with an absolute tmux and no creation flags (they would detach a ConPTY
      child). Windows now short-circuits and says so in Mobile settings.
      - [x] 🤖 Automated test — builder PATH assertions in discovery/pty_bridge
      - [ ] 🖐️ Manual test — macOS with Homebrew tmux: the phone lists
        terminals. Windows: the settings note appears and the phone lists none
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32f — fenced macOS agents can write the ordinary device files.**
      The Seatbelt profile denied all writes and never re-allowed `/dev/null`,
      so `> /dev/null` failed inside a fenced tab. Allows `/dev/null`, `zero`,
      `tty`, `dtracehelper`, `/dev/fd` — deliberately **not** `/dev/ttys*`,
      which would let an agent write into other tabs' terminals.
      - [x] 🤖 Automated test — profile ordering/content assertions (Linux-run)
      - [ ] 🖐️ Manual test — a fenced tab runs `git status >/dev/null && echo ok`
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32g — Docker Desktop / OrbStack CLIs on the macOS PATH**, and the
      **Tailscale CLI inside the app bundle** for App Store installs.
      - [x] 🤖 Automated test — `supplemental_path_dirs_for(Macos, …)`,
        `tailscale_program` with an injected `exists`
      - [ ] 🖐️ Manual test — per-user Docker Desktop: the container tier is
        offered. App Store Tailscale with no CLI on PATH: Mobile Serve reads
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32h — the fence install hint follows the distribution.** The
      one-click bubblewrap install hardcoded apt, and the fence fails closed, so
      a non-Debian user had no working path. `package_install_cmd` covers
      apt/dnf/pacman/zypper and returns `None` (button hidden) otherwise.
      - [x] 🤖 Automated test — os-release fixture table incl. `ID_LIKE` precedence
      - [ ] 🖐️ Manual test — Fedora/Arch: the pill's install button runs
        dnf/pacman; an unknown distribution hides it
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32i — the presenter's sleep inhibitor dies with Tabtivity.** It
      spawned `systemd-inhibit … sleep infinity` with nothing tying it to
      Tabtivity and no release on exit, so a quit or crash mid-talk kept the
      machine awake until logout. Now `systemd-inhibit … cat` holding a piped
      stdin (PDEATHSIG follows the forking *thread*, so it was the wrong tool),
      plus a release in `RunEvent::Exit`.
      - [x] 🤖 Automated test — argv builder; a pipe-close test proving the tie
      - [ ] 🖐️ Manual test — present, `kill -9` Tabtivity, then
        `systemd-inhibit --list` shows no Tabtivity row
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32j — the renderer reload budget is per window.** One process-wide
      counter meant a crash-looping popout could spend the main window's budget.
      - [x] 🤖 Automated test — pure budget helper; macOS label map
      - [ ] 🖐️ Manual test — hard to force; watch crash.log for a popout that
        loops while the main window still reloads
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32k — onboarding names the panel key that works here.** The copy
      hardcoded "Super" where the code already uses F9 (GNOME/KDE); it now asks
      `livePanelToggleKey()` and waits for the desktop probe.
      - [x] 🤖 Automated test — extended `SuperKeyOwnership`
      - [ ] 🖐️ Manual test — GNOME/KDE: How to start and the Feature Guide say
        F9; Cinnamon still says Super
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32l — Settings says when the desktop cannot park windows.** A
      `can_park()` backend capability (default true, null backend false) behind
      `workspace_capabilities`; the dead `workspace_info` fetch in `HeaderBar`
      is gone. Carries `UntestedTag`.
      - [x] 🤖 Automated test — backend capability test; the row renders only
        when `can_park === false`
      - [ ] 🖐️ Manual test — GNOME Wayland: Settings → Layout shows the note;
        Cinnamon or KDE X11 shows none
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32m — macOS gets an explicit menu, and ⌘W closes a tab.** Tauri's
      default menu bound ⌘W to Close Window, and a focused terminal swallowed
      the app's own chord, so ⌘W quit the whole app. The menu now omits Close
      Window, keeps **Edit** (which is what makes ⌘C/⌘V work in xterm — an
      explicit handler would double-paste) and routes ⌘Q through the window
      close so the frontend teardown runs. The keyboard bypass is strictly
      `IS_MAC && metaKey && !ctrlKey`, so ⌃W still reaches every shell.
      - [x] 🤖 Automated test — pure menu plan (no CloseWindow, Edit present);
        vitest for ⌘W vs ⌃W on macOS and Ctrl+W unchanged on Linux
      - [ ] 🖐️ Manual test — macOS: ⌘W in a focused terminal and in a popout
        closes the tab; ⌃W deletes a word; ⌘Q quits cleanly; ⌘C/⌘V still work
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32n — macOS window stays hidden until its placement is restored.**
      The per-platform config replaced the window array (RFC 7396), dropping
      `visible: false`, so the window flashed at its default spot on launch.
      - [x] 🤖 Automated test — a Rust test reading both config files
      - [ ] 🖐️ Manual test — macOS: no visible flash before the saved placement
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32o — housekeeping.** One Wayland predicate instead of three
      disagreeing copies (`Some("")` was read as X11); the deb drops the unused
      `libappindicator3-1` (universe-only on 26.04) and recommends
      bubblewrap/tmux/cups-client; the Windows dead-code warnings go 25 → 0 by
      cfg narrowing, never a blanket `allow`; staged clippy on the macOS CI job;
      `src-tauri/CLAUDE.md`, `docs/context/agent_authority.md` and `README.md`
      match the code again.
      - [x] 🤖 Automated test — covered by the existing suites and both cross-checks
      - [ ] 🖐️ Manual test — Ubuntu: `dpkg -I` on the CI .deb shows the new
        Depends/Recommends
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32p — frontend reads native Windows paths** (2026-10-07, ⚠️ never
      run on Windows). The rename retarget (`FileTree`, `tabs.retargetTabs`),
      the Rename dialog's folder label, Disk Usage's parent/picked-folder
      labels and the deck's file labels split on `/` only, so `C:\p\a.txt`
      came out whole or empty; now `basename`/`dirname`/`resolvePath` from
      `lib/paths`. `.ps1`/`.bat` Run quoted `'…'`, which cmd/PowerShell hand
      through verbatim; now `"…"`. Terminal/Reader path links accept
      `src\a.ts:120`, `C:\…\a.ts`, `.\src\a.ts`. `currentPlatform()` reads
      `lib/platform` instead of the UA string.
      - [x] 🤖 Automated test — `files/WindowsPaths.test.ts`,
        `run/ShellScriptRun.test.ts`, `terminal/PathLinks.test.tsx`
      - [ ] 🖐️ Manual test — Windows: rename a file open in a tab (tab follows),
        ▶ on a `.bat` runs it, an agent's `src\a.ts:12` is a link
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **32q — wired-network identity, dev-build chip, Ollama wording off
      Linux** (2026-10-08, plan §3.9, ⚠️ never run on macOS/Windows). The
      per-network default printer keyed a wired link by its gateway only on
      Linux (`/proc`); macOS now reads the `gateway:` of `route -n get default`
      and `arp -n <ip>`, Windows the lowest-metric `0.0.0.0` row of `route
      print -4` and `arp -a <ip>`, MACs canonicalised to the `/proc` spelling
      so the id is the same on every OS. The dev-build chip's lock check uses
      `apps::pid_alive` (no `/proc`), its own-binary check `current_exe`, and
      "Relaunch now" says it is Linux-only elsewhere. A blob Delete refused
      off Linux says the files belong to another account or are locked.
      - [x] 🤖 Automated test — `macos_route_get_names_the_gateway_and_the_interface`,
        `macos_arp_n_resolves_only_a_complete_entry`,
        `windows_route_print_picks_the_lowest_metric_default_gateway`,
        `windows_arp_a_resolves_the_gateway_row`, `every_os_spells_one_mac_the_same`
      - [ ] 🖐️ Manual test — on a wired link: Print manager → set "Default on
        this network" → the label names the gateway IP; unplug/replug or
        relaunch → the same default is applied; on another wired network it
        is not
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [ ] **32z — deferred from the sweep** (each needs live hardware or a
      product call first):
      - X11 backend on any X11 session — mutates the WM workspace count and
        survives crashes; needs live XFCE/MATE/i3.
      - KDE Wayland `info()` via D-Bus properties — needs live KWin.
      - Intel/xe iGPU readout — `vram_total: Option` ripples through TS and
        the remote parser.
      - GNOME projector blanking via the portal Inhibit — needs a live GNOME.
      - Distro hints beyond the fence — nothing else fails closed.
      - Windows renderer restart — WebView2 shares renderers across
        same-origin windows; one kill may take all.
      - Container credential freshness on Windows — needs Docker Desktop to
        see whether rename-over propagates.
      - Windows shutdown time budget — measure teardown on hardware first.
      - Roaming `%APPDATA%` state dir — needs a migration; niche.
      - Phone-side "no terminals on Windows" copy — new mobile API field +
        mobile-web i18n. Built 2026-10-07 (plan §3.4): the project detail
        carries `terminals: "tmux" | "unsupported"`; the phone keeps ＋ for
        its Send a file row only, hides Schedule and Mark up's Submit and
        shows one line.
        - [x] 🤖 Automated test — `mobile/MobileProjectTerminalsUnsupported.test.tsx`,
          `terminals_support_names_tmux_or_unsupported`,
          `a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner`
        - [ ] 🖐️ Manual test — Windows desktop, phone on the project screen:
          ＋ opens only "Send a file from this phone" (and it lands in the
          project inbox), no ◷ on agent cards, the Prompts sheet has no
          Schedule, a gallery picture has no Mark up, and the one line says
          tmux is missing
          - [ ] ✅ Works on Linux (X11)
          - [ ] ❌ Doesn't work on Linux (X11)
          - [ ] ✅ Works on Linux (Wayland)
          - [ ] ❌ Doesn't work on Linux (Wayland)
          - [ ] ✅ Works on Windows
          - [ ] ❌ Doesn't work on Windows
          - [ ] ✅ Works on macOS
          - [ ] ❌ Doesn't work on macOS
      - Job Object for ConPTY children — needs hardware to see current crash
        reaping.
      - Keychain file read for fenced Claude on macOS — security trade-off;
        probe on a Mac first.
      - Login-shell PATH import on macOS — runs user rc files.
      - `macOptionIsMeta`, ⌘\ panel toggle, fullscreen restore — product
        decisions; breaks international Option input.
      - `NSLocalNetworkUsageDescription`, richer macOS crash log — low value
        vs. signal-handler risk.

254. **The bare Super key belongs to the desktop, not to the OS.** ✅ Fixed
    2026-09-07, ⚠️ untested live. `useKeyboard` gated its lone Meta/Super panel
    toggle on `PLATFORM === "linux"`, which quietly asserts "on Linux this key
    is free". True of Cinnamon, where the binding was written; false of GNOME,
    which opens the Activities overview on Super and forwards a lone `Meta`
    keydown ahead of every `Super+<key>` shell shortcut. Moving a machine from
    Cinnamon to GNOME/Wayland therefore reintroduced the exact symptom Windows
    was carved out for in the first place — every Overview press toggled the
    panels off, and since `panelsHidden` also unmounts the reveal handle and the
    tour marker, the side panel left *nothing* at the edge to say where it went
    or how to get it back.

    Ownership of the key is now a backend answer about the running desktop
    (`platform::desktop_claims_super`, matched against `XDG_CURRENT_DESKTOP`:
    GNOME, KDE/Plasma and Unity claim it; Cinnamon, XFCE, sway and unknown
    desktops do not), read once per session through
    `commands::workspace::desktop_owns_super_key` and cached in
    `src/lib/shortcuts/superKey.ts`. F9 stays the toggle everywhere, and `FIXED_KEYS`
    advertises whichever key is actually live. A probe that cannot be answered
    keeps the binding: `src/` hot-reloads while `src-tauri/` does not, so a
    window running ahead of its backend must not lose the key on the desktops
    where it works.
    - [x] 🤖 Automated test — vitest `SuperKeyOwnership` (the binding follows
      the probe both ways, an unanswered probe keeps today's behavior, the
      sheet's advertised key follows, one probe per session) and cargo tests on
      `desktop_claims_super`.
    - [ ] 🖐️ Manual test — on GNOME: press Super for the overview and come back
      to Tabtivity with the side panel still there; F9 still toggles it; the F1
      sheet lists F9, not Super. On Cinnamon: Super still toggles.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **Follow-up (2026-09-07, same day, ⚠️ untested live):** the probe only
    helps a window whose backend can answer it, and the one on the desk could
    not — the binary predated the command, so the key still read as ours and a
    Super press right after a memory-watchdog reload took the side panel away
    again. The binding is now survivable on its own: the toggle fires on the
    lone key's RELEASE (`SUPER_RELEASE_SETTLE_MS` later), never on the keydown
    a shell forwards ahead of its own shortcuts. Any other key while Super is
    held makes it a chord and disarms it; a blur before the settle (the
    overview or launcher taking focus) cancels it. And hiding the panels now
    shows a 3 s toast naming the key that brings them back
    (`appShell.panelsHiddenToast`, via `livePanelToggleKey`), since the empty
    edge used to say nothing.
    - [x] 🤖 Automated test — vitest `SuperKeyOwnership`: toggle on release
      not keydown, chords don't toggle (auto-repeat still one press), a blur
      during the press or the settle cancels, the next lone press still works.
    - [ ] 🖐️ Manual test — on GNOME with the OLD backend (before relaunching):
      Super+Tab, Super+1, Super+arrow tiling and a bare Super for the overview
      all leave the side panel in place. Then F9 (or a lone Super on Cinnamon)
      hides the panels and a toast names the key; the same key brings them
      back with no toast.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

209. **Getting the app onto a machine, and keeping it current.** The two ends
    of distribution that were never Tabtivity's own: what the installer looks
    like, and how a user learns a newer build exists. Both landed 2026-08-26,
    both code-complete and **live-unverified** — the Windows half cannot be
    checked on Linux at all, and the Linux half needs an AppImage install and a
    real newer release to check against.
    - [x] **209a — Brand the Windows installer.** ✅ Done. `icon.ico` was
      already embedded in the exe (tauri-build does that from `bundle.icon`),
      but the NSIS template only defines `MUI_ICON`/`MUI_UNICON` when
      `installerIcon`/`uninstallerIcon` are set — unset, so the *setup* program
      shipped with the stock NSIS icon, which is what a user sees in Explorer
      and in the UAC prompt before anything is installed. Set both, plus
      `headerImage` (150×57) and `sidebarImage` (164×314), rendered from the
      brand SVG by `scripts/gen-installer-images.sh` into committed BMPs —
      committed because MUI reads only plain BMP and the Windows CI runner has
      no SVG renderer. `.gitattributes` marks image extensions `binary`: a
      24-bit BMP of a dark gradient can hold very few NUL bytes, so
      `text=auto`'s heuristic is not a safe thing to rely on when a CRLF
      rewrite would corrupt a build input.
      - [x] 🤖 Automated test — none possible; the bundler is the only consumer
      - [ ] 🖐️ Manual test — run the CI-built `.exe` on Windows: the setup
        program wears the Tabtivity icon, the welcome/finish page shows the
        sidebar, and the inner pages show the header
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **209b — Check for a new release, and install it.** ✅ Done.
      Settings → Updates: `services::app_update` reads the project's
      `/releases/latest` from the GitHub API, compares numerically (a lexical
      compare calls 0.1.9 newer than 0.1.10), picks the artifact matching the
      running platform, downloads it with progress, and hands it to that
      platform's own installer. Deliberately **not** the Tauri updater plugin,
      which wants a signed `latest.json` and a CI signing key that do not
      exist here. Two rules hold the boundary, because this ends by running a
      downloaded binary: every asset URL is checked against this repository's
      release-download prefix (the JSON is network input), and **no command
      takes a URL or a path** — the download re-checks for itself and the
      install acts on what the download staged. **Restarting is never
      Tabtivity's**: the AppImage path swaps the running file and says so, the
      NSIS path hands over to the installer (which offers to close Tabtivity), a
      `.deb`/package-manager copy is only told where the file went.
      - [x] 🤖 Automated test — `services::app_update` (13: version compare,
        pre-release ordering, the URL allowlist incl. a look-alike host, asset
        pick per platform, untrusted asset names, release parsing) +
        `src/__tests__/system/UpdatesPanel.test.tsx` (5: no URL/path crosses the IPC
        boundary, nothing downloads on open, `manual` offers no install)
      - [ ] 🖐️ Manual test — with an AppImage install and a newer release
        published: open Settings → Updates, check, download, install, restart,
        and confirm the new version runs
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] **Open:** no automatic check. A check happens only when the panel
        is opened, so a user who never visits it never learns of a release. An
        opt-in "check on launch" (default off) is the obvious follow-up and was
        left out deliberately rather than forgotten — it is the one part that
        reaches the network unasked.

- [~] **31af — Mobile Focus: a swipe shows the agent's status line** (2026-09-15;
  ✅ code-complete and automated tests passing, ⚠️ untested on a phone — and a
  rebuild + restart first, since the phone serves the bundle baked into the
  binary). Focus cuts the agent TUI's bottom frame (31v), and with it the rows
  drawn under the input box: cwd, branch, model, mode, context %, and any custom
  statusline, whose free text the composer chips have no shape for. A left→right
  swipe across the output now opens a strip under it with those rows verbatim
  (`statusFrameLines` in `mobile-web/src/terminal/statusLine.ts`). A right→left
  swipe or the strip's ✕ closes it, and a screen with no frame says "No status
  line on screen". `mobile-web/src/terminal/focusSwipe.ts` listens passively, so
  scrolling and selection stay native. It counts only a decisively horizontal
  swipe (≥ 56 px, ≥ 2× the vertical travel, ≤ 700 ms), and ignores one starting
  within 16 px of a screen edge (Android back), on an input, or inside something
  that can still scroll sideways. Swipe-only, never persisted. Tested in
  `src/__tests__/mobile/MobileTerminalFocusStatusLine.test.tsx`.
      - [ ] **Manual QA:** open a Claude agent tab → Focus → swipe right across
        the output: a strip opens under it showing the status row exactly as
        the desktop draws it (custom statusline included); swipe left, and
        separately tap ✕, and it closes; vertical scrolling of the output still
        works and never opens it; a wide code block still pans sideways instead
        of opening it; a swipe starting at the screen edge triggers Android's
        back gesture, not the strip; Terminal view shows no strip
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

- [~] **31ae — Every phone section glyph asks for emoji presentation** (2026-09-14;
  ✅ code-complete, tests passing, ⚠️ phone QA pending after a PWA rebuild,
  `1e7f9fb`). The tab bar drew Projects and Calendar in colour but To-do and
  Mail as thin grey line art: ☑ and ✉ exist as text symbols, so phones took them
  from a text font. One `SECTION_GLYPH` table (`mobile-web/src/glyphs.ts`),
  shared by the tab bar and Home's alert list, appends U+FE0F to all four; a
  test (`MobileSectionGlyphs`) guards the invisible selector.
      - [ ] **Manual QA:** on the phone all four tab-bar icons and the Home alert
        rows are colour emoji, none grey outline.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

- [~] **31ad — `tabtivity-send`: files from agent terminals to the phone** (2026-09-14;
  implemented, pending live QA). Local and
  container tabs get an installed command, scoped root env, and read-only
  mounts. Focus previews images/text/PDF and offers downloads and file sharing.
  After deliberately restarting Tabtivity, verify on the tailnet:
  1. Ask fenced Claude from Focus to render and show a plot; it should run
     `tabtivity-send` itself and the thumbnail should arrive within about 8 s.
  2. Pipe a test log with `tabtivity-send -n tests.log`; open the text chip.
  3. Send a PDF; it opens a new browser tab.
  4. Copy a PNG into `.tabtivity/outbox/` manually; its thumbnail still appears.
  5. Repeat the log from a container tab.
  6. Send a ZIP; Save downloads and Share offers other apps where supported.
  7. `tabtivity-send --clear` empties the strip; with the desktop closed, existing
     outbox files still list through the sidecar.
  8. Send text named `.png` and an SVG; both preview as inert text.
  9. Focus posts each file into the chat as an agent message (2026-09-15,
     `Untested` pill in its caption): with the stored session shown, a plot
     sits under the answer that sent it, not at the bottom; on the screen
     source (Session → Screen) the files close the chat; the strip above the
     composer shows only in the Terminal view.
  Windows PowerShell and macOS runtime behavior also require platform QA.

- [ ] **31bs — Every agent CLI learns `tabtivity-send` from Tabtivity, not the
  project** (2026-10-01; implemented, never live; the backend needs a restart).
  The hint left the scaffold's `AGENTS.md`. Codex now gets it from the session
  hook like Claude; `services::agent_hint` registers a SessionStart hook for
  Gemini, Qwen, Auggie, CodeBuddy, Droid, Cursor and Copilot, a managed
  block in Vibe's user `AGENTS.md`, and a hint file in OpenCode's
  `opencode.json` `instructions`, all in the agent home. Copilot's
  hook shape was probed against Copilot CLI 1.0.88 in a fenced tab (the model
  read the context); the rest is from each CLI's hook docs.
  - [ ] 🖐️ In a fresh project tab of each installed CLI, ask "How do you show
    me a file on my phone?" — it should name `tabtivity-send <file>` without
    reading any file. Codex needs its `/hooks` trust first; Cursor is known
    upstream to drop session-start context now and then.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ac — "Set up in terminal" opens in the root console** (2026-09-14;
  ✅ code-complete, tests passing, ⚠️ live QA pending). The Tailscale Serve
  guide's button switched the whole window to the root scope and opened a tab
  there, unlike every other one-click install. It now goes through
  `runInstallInTab`: the root tab still owns the PTY, and the root console
  floats over Settings with that tab in front (2026-09-17 — the separate
  install overlay was merged into the console); closing it leaves the command
  running in its root tab. The confirmation
  before running stays.
      - [ ] **Manual QA:** Settings → Mobile → open "Set up Tailscale Serve" →
        *Set up in terminal* → confirm. Expect the overlay terminal over
        Settings running `tailscale serve --bg …`, the active project unchanged,
        and a root tab holding the same terminal after closing the overlay
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

- [~] **31ab — Mobile Focus reads as a chat** (2026-09-05; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending — and a rebuild + restart first,
  since the phone serves the bundle baked into the binary). Focus painted an
  agent session as one flat column, so the user's own prompts sat in the flow
  in the TUI's dim grey and a reader had to find `>` lines to tell a turn from
  an answer. Now an agent tab lays out like a chat: the agent's turns on the
  left, exactly as printed, and every prompt the user submitted as a violet
  bubble on the right (the composer's own "Sent" tint, so it reads as *mine*
  without a label). The one shape this reads is the echo every agent TUI
  writes back into its transcript on submit — the input marker at the left
  edge, a space, the text (`> …` in Claude Code, Gemini CLI and Qwen Code once
  the box frame is stripped, `› …` in Codex), with a multi-line prompt's
  further lines indented under it. A select dialog's `❯ 1. Yes` row is excluded
  by its number, an indented quote inside an answer by its indent, and the live
  input box at the bottom never reaches it (`inputFrameStart` cuts first).
  `mobile-web/src/terminal/chatTurns.ts` does the grouping; `ReadableTurns` in
  `Terminal.tsx` renders it per history chunk, open chunk and live tail, still
  memoized on the chunk reference. Copy still copies the transcript as printed,
  marker included; a shell tab is untouched. Tested in
  `src/__tests__/mobile/MobileChatTurns.test.ts` (7 cases) and
  `MobileTerminalReadableView.test.tsx` (2 cases); `/terminal-preview.html`
  shows two exchanges.
  - [ ] Manual phone QA (2026-09-15): Codex labelled dividers such as
    `─ Worked for 2m ─────` show only their label in Focus, with no wrapped
    white rules; input-frame labels remain hidden. Regression coverage in
    `MobileReadableScreen.test.ts`; live verification pending.
  - [ ] 🖐️ Manual phone QA — open a Claude agent tab in Focus and send a prompt
    from the composer: it appears as a bubble on the right, in the same violet
    as the "Sent" strip, without the `>`; the answer sits on the left as
    before, colours intact; a multi-line prompt stays one bubble; a permission
    question's numbered rows stay on the left and answerable; the live input
    box is still not painted; Copy still includes `> `; a Codex tab shows the
    same for `›`; a shell tab shows no bubbles.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - 2026-09-16 fix: a user bubble sometimes held text the user never typed.
    Two sources feed the bubbles and both leaked. **Stored session** (the
    default for Claude/Codex): the not-a-prompt filter was a short start-only
    prefix list, so `<tool_use_error>` blocks and a `<total_tokens>` block
    appended *behind* a prompt were shown as the user's words. It is now a
    bound *plus* a shape — `CLI_BLOCK_TAGS` and "opens and closes with that
    same tag" — because a shape alone cannot tell a CLI's private block from
    someone pasting `<div>hello</div>`; `strip_trailing_blocks` cuts only
    those tags off the end, and `isCompactSummary`/`isVisibleInTranscriptOnly`
    join `isMeta`/`isSidechain` as never-a-prompt. **Screen reading**: `❯` is
    no longer an echo marker (no CLI echoes with it — it is the select-dialog
    cursor, so every `❯ Opus 4.1` and `/resume` row became the reader's
    words), `✨` counts only for a tab whose label names Kimi, the empty box's
    own placeholder and a box the TUI is still drawing are not submissions,
    and a bubble stops at a tool-result gutter or a footer row.
    The mirror direction — a guard costing the user their own words — turned
    out to be just as real and is now covered too: a pasted `tree` stays in
    the bubble (frame strokes are not stop rows), `> try "npm ci" first` is a
    prompt and not the placeholder, an answer *about* a key no longer
    swallows the prompt above it, and a columned status row is told from
    prose by *columns* carrying status rather than fields (`classify` reads a
    branch out of the same segment as the path, which scored the ordinary
    sentence `~/tabtivity/projects/app (main)` two and handed the prompt to the
    agent). The same parser feeds the desktop's last-prompt line, so both
    directions reach the prompt chart too.
    Gates: 202 mobile tests, 46 `agent_session` + 4 `agent_transcript` Rust
    tests, clippy clean, `mobile:build` and `vite build` green, lint clean on
    the changed files. Backend and PWA both changed, so this needs
    `npm run package:dev` and a relaunch before a phone sees it.
    Known and deliberately left: a prompt whose *continuation* is itself a
    columned row (`opus-4.1   ~/a`) still reads as a box; a Codex gutter drawn
    `└─ ` rather than `└ ` would land in a bubble (not seen in any version);
    a quoted `│ > … │` inside a plan box is byte-identical to Gemini's framed
    echo after the frame is stripped, so it cannot be separated without a live
    capture; and the Kimi `✨` branch hangs off a renamable tab label, which is
    harmless only because the phone cannot open a Kimi tab today (31ag).
  - [ ] 🖐️ Manual phone QA — in a Claude and a Codex tab, check the bubbles
    hold only what was typed: run a slash command (`/model`) and confirm its
    `⎿` result stays on the left; scroll back to an old screen and confirm no
    stale draft or `Try "…"` placeholder appears as a bubble; open `/model`
    and confirm its `❯` rows stay left. Then the mirror: paste a `tree` into a
    prompt and send it — the whole thing stays in one bubble; send `try "npm
    ci" first` and `where am I?` and confirm each still appears as yours.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31aa — Project boxes reach the phone** (2026-09-05; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending — and a rebuild + restart
  first: the sidecar's catalog, a backend command and the embedded PWA all
  changed). A box was the one scope with its own tabs the phone could not
  see: the sidecar walked `projects.json` only, and the plan listed box scopes
  under "excluded". A box is a scope of its own on the desktop — `box:<id>`,
  its own `sessions/box_<id>/` file, its own `tabtivity-box_<id>--…` tmux names,
  tabs that run locally whatever its members are — so it now reaches the
  phone as one, behind a switch of its own: `tabtivity_mobile_access` on the box
  record in `boxes.json`, a **Box access** list under Project access in Mobile
  settings (`set_box_mobile_access`, which also resolves the box folder). The
  sidecar lists an enabled box as a `kind: "box"` row (always "active"; the
  phone prints "▣ box" where a project row prints its status) and takes the
  tabs whose cwd is the box folder or a *local* member's root; a container, VM
  or remote member contributes no root, and a member's own switch is not
  consulted — nor does the box's switch list its members. The bridge resolves
  a `box:<id>` id through `mobileScope` beside project ids (catalog, activity,
  create, activate → `openBox`, rename, status, seen, inbox), and CenterPanel
  lets the box's switch stand in for the project's in the agent-tab tmux wrap,
  so a resumable agent opened in a box becomes attachable like a project's.
  Locked by `MobileBoxAccess.test.tsx`, the `MobileHome` badge case, and the
  `discovery.rs` / `host.rs` box tests.
  - [ ] 🖐️ Manual phone QA — Settings → Tabtivity Mobile → Box access: switch a
    box on (a never-opened box gets its folder); the phone's Projects list
    shows it with "▣ box"; open it: the box's shell tabs and a Claude tab
    opened in the box after the switch are listed and attach; a member with
    its own switch off is *not* in the list; switch the box off: it vanishes
    from the phone within a poll.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31z — The phone's ✓ ticks a card instead of moving it** (2026-09-05;
  ✅ code-complete and automated tests passing, ⚠️ phone QA pending — and a
  rebuild + restart first: the bridge gained a to-do action and the sidecar's
  `TodoColumn` gained two flags). Every tick and untick from the phone came
  back as `column_follows_date`, and the raw wire code is what the board
  showed. The checkbox was sending a **move** into the Done column (and back
  into the intake one), and a move is a placement: the desktop board refuses
  one its own rules would immediately undo, and a card at 100% is *shown* in
  Done whatever its column says — so the phone's checkbox spoke the one dialect
  the board could not accept. It is now its own action (`TodoAction::Toggle`)
  running the desktop's `toggleTaskDone`, so completion, the completed stamp
  and the filing are one edit and there is one rule for what a tick means on
  both surfaces. Two smaller halves of the same seam: the per-card **Move**
  picker greys out the columns a card's deadline governs (`TodoColumn` now
  carries `overdue`/`due_today`, and `mobile-web/src/todoDates.ts` mirrors
  `dateColumn`'s three refusals) instead of offering a move that errors; and a
  refusal that does arrive is read as prose — *"Overdue, Today and the backlog
  follow the card's own deadline"* — rather than as its code. Tested in
  `src/__tests__/mobile/MobileTodoDateColumns.test.tsx`.
  - [ ] 🖐️ Manual phone QA — with the desktop open: tick a card on the phone's
    board → it goes to Done there and on the desktop, and the desktop's card
    shows a completion date; untick it → it comes back to the backlog. Open a
    card's Move picker: for a late card only Overdue (plus Doing/custom/archive
    columns) is selectable, for a card due today only Today, and Overdue is
    greyed for anything not late. Moving a card into Doing and back still works.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31y — The phone's Alerts rows carry the desktop's Done ✓** (2026-09-04;
  ✅ code-complete and automated tests passing, ⚠️ phone QA pending — and a
  rebuild + restart first: the phone serves the bundle baked into the binary,
  and the desktop bridge gained a request). Alerts was the one companion
  surface that could only *hand off*: a card that was already done, a meeting
  already over, a mail already dealt with stayed on the phone's strip until
  somebody reached a laptop, which is the opposite of what an alert feed is
  for. Each row now carries the same ✓ the desktop strip has, and it means the
  same three things because it *is* the same code — the resolutions moved to
  `src/lib/alertDone.ts` and both surfaces call it: a card is completed into
  the board's configured Done column, a mail's local priority mark is cleared
  (never a server flag, never a delete), a meeting is muted in the strip and
  stays in the calendar. The boundary is unchanged in kind: the snapshot gains
  one opaque per-row handle (`alert_id`, domain-separated like every other
  mobile id), the phone sends back that handle and nothing else, and
  `POST /api/v1/alerts` is origin-checked and validates only its shape — what
  the ✓ *does* is decided desktop-side from the row it resolves. The answer is
  the feed as it stands afterwards, so the phone never guesses what a ✓ removed.
  **Until that restart the phone shows no Alerts section at all**, and that is
  this seam rather than a bug: `src/` hot-reloads, so the running window's
  bridge already sends the new `alert_id`, while the sidecar baked into the
  binary is a `deny_unknown_fields` build that does not know the field and
  rejects the whole snapshot. The phone reads that as a feed it cannot load and
  draws nothing.
  - [ ] 🖐️ Manual phone QA — with the desktop open: a due card, an urgent mail
    and an upcoming meeting on Home's Alerts strip. Tap the ✓ on the card →
    the row goes and the desktop board shows it in Done. Tap the ✓ on the mail
    → the row goes and the desktop's Urgent list no longer holds it (the
    message itself untouched, unread state unchanged). Tap the ✓ on the meeting
    → the row goes and the appointment is still in the desktop calendar,
    listed under the strip's 🔕 count. Then close Tabtivity on the desktop and tap
    a ✓ → "could not be completed", the row still there.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31g — Tabtivity Mobile sidecar on macOS & Windows** (2026-08-26; ✅
  Code-complete, ⚠️ needs live QA on real macOS/Windows machines).
  The separate `tabtivity-mobile-host` cargo bin is gone — the sidecar is a copy
  of the Tabtivity binary run with `--mobile-host`, which is also what fixed the
  `package-macos` CI job (Tauri never lipo-merges secondary binaries into a
  `universal-apple-darwin` bundle, so the copy step failed on every macOS
  build). macOS installs a launchd LaunchAgent
  (`io.github.fseiffarth.tabtivity.mobile-host`, `KeepAlive.SuccessfulExit=false`
  ≙ `Restart=on-failure`); Windows registers an HKCU Run-key autostart and
  speaks the admin/desktop control planes over tokio named pipes with a
  same-user token handshake (`services/mobile_control/admin.rs::pipe`) because
  `tokio::net::UnixStream` does not exist there. Windows terminal attach still
  requires tmux, so only the desktop-mediated surfaces (pairing, mail,
  calendar, to-dos) work there; the phone-install QR handoff (bash+jq) is
  hidden on Windows and state-dir-aware on macOS.
  - [ ] 🖐️ Manual test — macOS: enable Mobile in Settings, confirm the launch
    agent starts, pair a phone, attach a tmux tab
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — Windows: enable Mobile, confirm the host starts and
    survives logoff/logon, pair a phone, open mail/calendar/to-dos
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31h — Mobile composer status chips** (2026-08-28; ✅ Code-complete, ⚠️
  needs live QA on a phone against a real Claude Code / Codex tab).
  The phone Terminal screen's composer now has the official Claude Code mobile
  shape: a ＋ button (inserts an `@` file mention into the draft), a model chip
  and a mode chip on a bar under the textarea, plus a small path · branch ·
  context readout above it. The labels come from
  `mobile-web/src/terminal/statusLine.ts`, which parses the status area the
  agent TUI draws *below its own input box* (path, branch, model, mode,
  context %) out of the readable screen — only below a recognized input
  prompt, only positive matches, generic "Model"/"Mode" labels otherwise.
  Tapping the model chip sends `/model` and the mode chip sends Shift+Tab, so
  the chip labels follow the TUI's own redraw — both taps now open a list sheet
  instead (see 31j). Tested in `src/__tests__/mobile/MobileStatusLine.test.ts`.
  - [ ] 🖐️ Manual test — on the phone, open a Claude tab: chips show the
    model/mode from the statusline, `/model` picker opens from the model chip,
    mode chip cycles plan/accept-edits, ＋ inserts `@` into the draft
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31x — Mobile Agents mode: every waiting session, no project grouping**
  (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ phone QA pending
  — and a rebuild + restart first, since the phone serves the bundle baked into
  the binary). The phone is picked up to answer one question — *is anything
  waiting for me* — and the project grouping stood squarely in front of it: the
  reader opened each project in turn to find the one session that had stopped to
  ask something. The Projects tab now has a third mode beside Active and Search.
  **Agents** lists every agent tab that is working, waiting on a decision, or
  done, flat across every project the phone may reach, waiting-first and
  finished-last, each row carrying its project name and the same status pill the
  project overview draws. Tapping one goes straight into the session and back
  out to the list, not through the project it lives in; nothing quiet is listed,
  so an empty list means an empty list. The mode is remembered
  (`prefs.projectsAgents`) because a tab switch and every terminal visit
  re-mount the section, and re-picking it each time is the whole cost of using
  it as a triage list. New `GET /api/v1/activity` answers the whole list in one
  desktop round trip (`DesktopRequest::Activity` — a per-project `Catalog` call
  would be one round trip per project on every 5s poll, and the flat list needs
  neither the agent menu nor the schedule summaries). The desktop still owns the
  classification and the sidecar still never reads terminal output, so with no
  desktop window the screen says *that* rather than showing every tab as quiet;
  the bridge gates each project through the same `mobileProject` check as every
  other handler, so the Mobile switch and the remote/sandbox/VM tiers hold.
  Behind the mode, neither the project list nor the alerts feed is polled.
  Locked by `src/__tests__/mobile/MobileAgentsMode.test.tsx` and the `host.rs` activity
  route tests.
  - [ ] 🖐️ Manual phone QA — with two projects each holding a busy agent tab:
    open Projects → **Agents** and see both, waiting-first, each naming its
    project; tap one and land in the session, back out to the list still in
    Agents mode; leave to To-do and return (still Agents); switch to Active and
    return (Projects again); watch a tab's pill follow the desktop as it goes
    working → question → done; close desktop Tabtivity and see the "Desktop
    unavailable" line instead of an empty-and-quiet reading; with everything
    idle, confirm the list is empty and says so
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31i — Mobile lazy terminal history, whole session** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone; the tmux `history-limit` half
  needs a backend restart and takes effect per newly created session).
  The phone Focus view no longer clips at 400 lines: lines that scroll out of
  the live tail are absorbed once into frozen, memoized chunks
  (`mobile-web/src/terminal/readableHistory.ts` — trim-aware via xterm's
  internal `onTrim`, falls back to the old bounded view if that internal moves)
  and a "Show earlier output (N lines)" button at the top lazily reveals them
  page by page (~800 lines/tap, scroll-anchored), up to 20k lines in memory.
  Depth is one number by design: tmux sessions are now created with
  `history-limit 10000` (`ssh_exec::TMUX_HISTORY_LINES`, set *before*
  `new-session` in both the remote wrap and `tmux_local` — a pane copies the
  limit at creation), the sidecar replay captures the same depth
  (`pty_bridge::MOBILE_SCROLLBACK_LINES`), and the phone xterm's scrollback
  matches (`PHONE_SCROLLBACK`). Copy copies exactly what is revealed. Tested in
  `src/__tests__/mobile/MobileReadableScreen.test.ts` (lazy-history describe block).
  - [ ] 🖐️ Manual test — on the phone, open an agent tab with a long session:
    "Show earlier output" appears, reveals older lines without the view
    jumping, repeated taps walk back to the session start, reconnect (airplane
    mode toggle) replays without duplicating lines
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31j — Mobile model/mode chips open a list, not a TUI dialog**
  (2026-08-28; ✅ Code-complete, ⚠️ needs live QA on a phone against a real
  Claude Code / Codex tab).
  Both composer chips now open a bottom sheet with a tappable list — name,
  description, a check on the one the session is in — instead of leaving the
  reader to walk a dialog that reflows into nonsense at phone width.
  - **Model**: the chip still sends `/model`; the sheet lists the rows the
    session's *own* picker drew, read by `mobile-web/src/terminal/selectPrompt.ts`
    (a contiguous run of numbered rows carrying exactly one highlight marker —
    anything else is not a dialog and the sheet steps aside after 6s). A tap
    moves the highlight with the same ↑/↓ + Enter the on-screen key row sends;
    dismissing sends Esc. Nothing decides what the models are but the session.
  - **Mode**: neither CLI has a mode picker, so the sheet lists the family the
    session's *reported* mode belongs to (`terminal/agentModes.ts`: Claude
    default/accept edits/plan/bypass permissions, Codex read only/auto/full
    access) and applies one by pressing Shift+Tab until the redrawn status line
    reports it — no cycle order assumed, a full lap without a match leaves the
    session where it was and says so. A session whose mode no family claims
    keeps the old single-cycle tap. `statusLine` learned Codex's bare `auto`
    (anchored, so Claude's `auto-compact` and `~/…/auto/…` stay unmatched).
  Tested in `src/__tests__/mobile/MobileSelectPrompt.test.ts` and
  `src/__tests__/mobile/MobileOptionSheet.test.tsx`.
  - [ ] 🖐️ Manual test — on the phone, open a Claude tab: the model chip opens
    a list of the real models with the current one checked, tapping one
    switches it (chip label follows), ✕ closes both sheet and picker; the mode
    chip opens the four modes, tapping Plan lands in plan mode, tapping bypass
    on a session without it reports the failure and leaves the mode unchanged
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31l — Mobile Focus mode chips for all agent families** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone).
  The mode sheet now covers every agent whose TUI actually prints its mode,
  keyed by the tab's agent label as well as the shown mode:
  - **Claude default** — Claude Code prints *nothing* in default mode, so the
    sheet never appeared for the most common state. A `silent` mode on the
    family reads an input frame with no mode text as "default" (label-gated:
    only a tab labelled Claude earns it), so the sheet opens, marks Default
    current, and a walk *to* default can confirm.
  - **Qwen Code** — full family (Ask permissions / Plan / Accept edits / Auto
    / YOLO); all five are on its Shift+Tab cycle and each draws indicator
    text (English locale), so every switch is verifiable. `statusLine` learned
    the shapes, the `*` YOLO prompt prefix, and decimal `45.2% context used`.
  - **Gemini CLI** — deliberately no family: since ~0.5 the approval mode is
    only prompt colour + aria-label, nothing the readable view can parse, so
    the chip keeps blind-cycling. Its `NN% used` context column is read.
    *Superseded by 31ag (2026-09-15): the mode is text after all, on the row
    above the box, and Gemini has a family now.*
  - Vibe/OpenCode are alt-screen TUIs (Focus already hands them to Terminal);
    Aider is a plain REPL. `scripts/backend-stale.sh` now also flags a stale
    *embedded* mobile bundle (mobile-web src newer than mobile-dist, or
    mobile-dist newer than the running process) — the phone serves the bundle
    baked in at compile time, which is how "Claude without the Terminal
    toggle" happened while every source file was right.
  - [ ] 🖐️ Manual test — on the phone: a Claude tab in default mode shows
    "default" on the mode chip and the sheet opens with Default checked;
    walking Default→Plan→Default confirms both ways; a Qwen tab lists five
    modes and lands on the tapped one (incl. YOLO, whose prompt turns `*`);
    a Gemini tab still blind-cycles but shows its `% used` as context
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ag — Mobile Focus beyond Claude Code** (2026-09-15; ✅ code-complete
  for the screen half, ⚠️ untested live; phone needs a rebuild + restart).
  A survey of all 26 other agent CLIs, read out of their published bundles
  (`docs/mobile_focus_cli_survey.md`), and what it changed:
  - `chatTurns`: Gemini `✦`, Qwen `◆︎` and Kimi Code `●` answers lay out as
    answers; Kimi Code's `✨` echo is a prompt bubble.
  - `statusLine`: a `*` input line with a draft counts only beside the word
    YOLO, so a markdown bullet at the bottom of an unrecognized TUI is no longer
    cut as the input box; Gemini's approval mode is read from the row *above*
    its box (and cut with it); `ctx` labels a context figure.
  - `agentModes`: a Gemini family (default silent / accept edits / plan on
    Shift+Tab, YOLO on Ctrl+Y) — this supersedes 31l's "no Gemini family".
  - [ ] 🖐️ Manual test — on the phone, a Gemini tab: answers show without `✦`;
    the mode chip reads default / accept edits / plan as Shift+Tab cycles on
    the desktop, and the sheet walks between them; a Claude tab whose answer
    ends in a `* item` list still shows the list's last rows.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] **Follow-ups** (see the survey for each spec):
    - [ ] Stored-session readers in `agent_transcript.rs` for the full-screen
      and inline CLIs that keep one: Gemini, Qwen, Kimi Code, Pi, Vibe,
      OpenCode/Crush/Goose (SQLite), Aider, Copilot, Muse.
    - [ ] Widen `discovery.rs::resumable`'s list and publish the tab's `cmd`,
      so families stop depending on a renamable label.
    - [ ] Live captures, then patterns, for Aider, mini-SWE-agent, Cursor
      agent, Goose, Grok Build, Kimi Code modes, OpenCode `--mini`, Codex 0.155
      `↳ Recap:`.
    - [ ] Registry fixes: Kiro binary is `kiro-cli`; Kimi Code / Pi / Amp
      packages moved; archived Mentat / GPT Engineer / Plandex / SWE-agent.

- [~] **31n — Mobile Focus: + attaches from the phone; sheets freeze the view**
  (2026-08-31; ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild +
  restart first, since the phone serves the bundle baked into the binary).
  - **+ → "From this phone"** opens the phone's own picker (camera / photo
    library / files, multiple). Each file is `POST`ed raw to
    `/api/v1/tabs/{id}/inbox` (own 24 MiB body limit) and lands in the tab's
    project under `.tabtivity/inbox/<UTC stamp>-<safe name>` — a folder the
    desktop already git-ignores, hides from the tree and skips in sync — and
    the phone writes `@.tabtivity/inbox/<file>` into the draft as each one lands.
    The reference is *project-relative* on purpose: no host path crosses the
    browser API, and it is what the agent needs from its own cwd. "A project
    file (@)" is the old + behaviour. A pending/failed row sits above the
    composer (oversized files never leave the phone; failures name the reason).
    The write is defensive (`inbox.rs`): sanitized + stamped name,
    `create_new`, inbox must canonicalize below the project root.
  - **+ → "From the gallery"** (2026-09-17): the same drop behind a second
    hidden input with `accept="image/*,video/*"`. A bare file input lands in
    the file browser on many Android phones; a media `accept` is what opens
    the photo picker (iOS: the library). Same 24 MiB limit, same `@` reference.
  - **Frozen reading view**: while the model or mode sheet is up, the Focus
    pane keeps the frame it held when the sheet opened; the `/model` picker
    and the Shift+Tab status redraws are still *read* from the live screen
    (the sheet lists the picker, the walk confirms against it) but not painted
    behind it. Closing the sheet resumes the live view.
  - [ ] 🖐️ Manual test — on the phone: + → From this phone → pick a photo →
    "Sending…" row appears, then `@.tabtivity/inbox/….jpg ` lands in the draft and
    the file is in `<project>/.tabtivity/inbox/` on the desktop; send the message
    and Claude reads the image; pick a >24 MB video → refused without upload;
    + → A project file inserts a bare `@`. Open the Model sheet → the picker
    text does not appear behind the sheet; close it → the view resumes
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — on the phone: + → From the gallery opens the photo
    picker (not the file browser); pick two photos → both land in the draft
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31u — Mobile Focus: + attaches an image from the desktop** (2026-09-03;
  ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild + restart
  first: the phone serves the bundle baked into the binary, and the desktop
  bridge gained two requests). What the Claude app's paperclip does for an
  image on the *desktop*: a screenshot just taken, a picture just downloaded,
  the clipboard — without a hunt through a file picker on the wrong device.
  - **+ → "From the desktop"** opens a sheet the desktop fills (`GET
    /api/v1/tabs/{id}/desktop-images`): the clipboard's image when there is
    one, then the newest 40 images of the platform's screenshot/picture
    folders (Linux honours `user-dirs.dirs`; macOS lists the Desktop first)
    and Tabtivity's own screenshot staging area — name, folder label, age, size.
    Picking one (`POST …/desktop-images` `{image_id}`) has the desktop copy it
    into the same `.tabtivity/inbox/` a phone upload lands in, and the phone
    writes `@.tabtivity/inbox/<file>` into the draft as it lands, with the same
    pending/failed row as a phone file.
  - **No path crosses.** Each file is named by an opaque id (a hash of its
    path, `services::desktop_images`); attaching re-scans the same folders for
    that id, so the phone can only ever name something the desktop would have
    listed. The sidecar refuses a malformed id before any desktop call. The
    clipboard is read on the desktop (`arboard`, bounded to 3 s so an X11
    transfer timeout cannot exhaust the bridge deadline) and encoded to PNG.
  - [ ] 🖐️ Manual test — take a screenshot on the desktop (or copy an image);
    on the phone: + → From the desktop → the sheet lists "Clipboard image ·
    W×H" first and the screenshot under "Screenshots"/"Tabtivity screenshots" →
    pick one → "Copying from the desktop…" row, then `@.tabtivity/inbox/….png `
    lands in the draft and the file is in `<project>/.tabtivity/inbox/`; send and
    Claude reads it. Clear the clipboard, reopen the sheet → no clipboard row.
    With Tabtivity closed → the sheet says the desktop is not answering.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bd — Mobile Focus: the agent's pictures reach the phone** (2026-09-05;
  ✅ code-complete, automated tests passing — `outbox.rs` unit tests, the
  sidecar route test, `MobileTerminalOutbox.test.tsx`; ⚠️ needs live QA on a
  phone, and a rebuild + restart first: the sidecar gained two routes and the
  phone serves the bundle baked into the binary). What the Claude Code remote
  app does when its agent reads a screenshot — shows it — done without a
  transcript: a terminal carries no images, so the agent copies the picture
  into the project's `.tabtivity/outbox/` (the inbox's mirror; git-ignored,
  hidden from the tree, skipped by sync, writable under the agent fence) and
  the phone lists that folder.
  - **Sidecar** (`services::mobile_control::outbox`): `GET
    /api/v1/tabs/{id}/outbox` lists leaf name / kind / size / mtime, newest
    first, 40 at most, read from disk by the sidecar itself — no desktop
    round trip; `GET …/outbox/{name}` serves the bytes typed by their own
    header. Folder must canonicalize below the project root; symlinks inside
    it are never followed; PNG/JPEG/GIF/WebP by magic bytes only (no SVG —
    script); 24 MiB cap; safe-alphabet leaf names only; every refusal is one
    `image_not_found`.
  - **Phone**: Focus polls the listing every 8 s while the page is visible
    (and at once when it comes back) and shows a **From the agent** strip
    above the composer — thumbnails loaded from the tab's own route on the
    session cookie, age under each — one tap to a full-screen view, ✕ hides
    the current set until a newer picture lands. No image is ever copied on
    the agent's behalf (a Read-tool hook would file pictures from anywhere
    on the host into a project tree — the thing the inbox's consent design
    guards against); the scaffold's `AGENTS.md` tells agents about the folder.
  - [ ] 🖐️ Manual test — in an agent tab: "take a screenshot of the window
    and copy it to .tabtivity/outbox/" (or `cp` any PNG there) → within ~8 s the
    phone's Focus view shows a **From the agent** strip with the thumbnail;
    tap → full screen, Close returns; ✕ → strip gone; copy a second image →
    strip returns with only the new one. Put a `.txt` renamed to `.png` there
    → not listed. With Tabtivity closed → the strip still lists what is there.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31w — Reconnect survives the binary being replaced under a live
  window** (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ not
  live-verified — the fix reaches the running window only after a deliberate
  restart). Reconnect (and Settings → Mobile's enable) reinstalls the sidecar
  by copying the running Tabtivity binary, and it took its source from
  `std::env::current_exe()` — which on Linux is `/proc/self/exe` *resolved to a
  path*. Replace the running image and that path comes back
  `…/tabtivity (deleted)`: `mobile_host_apply` then died at its copy step with
  `read mobile host: No such file or directory (os error 2)` before the service
  manager was asked for anything, so the journal recorded nothing at all and
  Mobile could not be brought back without relaunching Tabtivity. Every way the
  binary is replaced under a live window hits it — any `cargo build`/`cargo
  test` relinking `target/debug/tabtivity` under the hot-reload window, the
  post-commit auto-freeze rewriting `~/.local/share/tabtivity/tabtivity-dev` under the
  frozen one, an in-app update — i.e. exactly when the user reaches for
  Reconnect, and now on every commit. The source is now the magic link
  itself, which opens the running inode whether or not a path still names it;
  other platforms have no such link and keep `current_exe`. Locked by
  `the_sidecar_is_copied_from_the_running_image_not_a_path_that_can_vanish`.
  - [ ] 🖐️ Manual test — with Tabtivity running, rebuild it (or re-run
    `npm run package:dev`) so its binary is replaced, then press Reconnect in
    the Mobile menu: the host restarts (`journalctl --user -u
    tabtivity-mobile-host` shows a fresh `Started`) instead of reporting
    `os error 2`, and the phone reaches it again.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31o — Mobile names which machine failed, instead of "Host unavailable"**
  (2026-09-01; ✅ Code-complete, ⚠️ needs live QA on a phone — and a rebuild +
  restart first, since the phone serves the bundle baked into the binary).
  Prompted by a real outage: the phone had dropped off the tailnet for a day,
  and the only thing the app could say was "Host unavailable" with a Retry
  button, which is equally true when the sidecar is dead, when Tabtivity itself is
  closed, and when the browser blocked the key store — four different fixes
  behind one sentence.
  - `mobile-web/src/connection.ts` classifies a failed request into one of nine
    reasons and pairs each with copy that names the machine to go and fix. The
    split that carries it: `api()` reports a transport failure as status `0`
    (nothing answered — off the tailnet, or the desktop is asleep), while an
    HTTP error means something *did* answer, and only the sidecar sends a JSON
    `error` code — so a gateway status carrying the bare `request_failed`
    fallback is the proxy's, i.e. the sidecar is not listening, whereas a `503`
    reading `desktop_unavailable` is the sidecar's own report that Tabtivity is
    closed. Where the phone genuinely cannot tell two causes apart it names
    both rather than blaming one.
  - Shown on the unavailable splash (title + what to do + the raw `status code`
    for a bug report) and on the Home list's error line.
  - Fixes a real bug found on the way: `resumeAuth` treated *any* 403 as a
    rejected device, so a rejected **origin** — the host refusing the address
    the app was opened from, which re-pairing cannot fix — sent the reader to a
    pairing screen that could only fail again.
  - Tested in `src/__tests__/mobile/MobileConnectionError.test.ts` (10 cases).
  - [ ] 🖐️ Manual test — on the phone: turn Tailscale off → "Can't reach your
    desktop" naming Tailscale *and* a sleeping desktop, not "Host unavailable";
    turn airplane mode on → "This phone is offline" instead; with Tailscale up
    but Tabtivity closed on the desktop → an error naming *Tabtivity Mobile* /
    *Tabtivity* rather than the phone; each shows a `status code` line
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31k — Mobile fingerprint unlock is the default** (2026-08-28;
  ✅ Code-complete, ⚠️ needs live QA on a phone).
  The local lock used to demand PIN *then* biometric; now the enrolled
  WebAuthn platform credential alone unlocks, prompted automatically as the
  locked screen opens (a browser that wants a user gesture — iOS Safari —
  gets a "Unlock with fingerprint" button instead), and the PIN is the
  fallback for a failed/unavailable authenticator. Either factor alone
  suffices — the lock guards casual access and the paired signing key is a
  non-exportable CryptoKey the PIN never encrypted. A successful biometric
  unlock clears the PIN lockout counter; a PIN lockout does not block the
  biometric path. An existing record with no credential (setup ran where
  `isUserVerifyingPlatformAuthenticatorAvailable()` said no — e.g. Firefox
  Android, or no OS screen lock at the time) is **retro-enrolled**: a
  successful PIN unlock on a now-capable browser raises the enrollment sheet
  (`maybeEnrollBiometric`, announced in the unlock copy first), so fingerprint
  becomes the default from the next unlock without re-pairing; a refused
  enrollment just stays PIN-only and offers again next time
  (`mobile-web/src/localLock.ts`, `mobile-web/src/screens/LocalUnlock.tsx`).
  A browser that exposes **no** platform authenticator now says so and names
  the remedy, rather than silently showing a PIN field: DuckDuckGo (and every
  other browser built on the system WebView) has no WebAuthn, which is why
  this never appeared on a phone before — the note points at Chrome/Safari
  and warns that re-pairing is the cost, a pairing being per-browser
  IndexedDB state.
  - [ ] 🖐️ Manual test — on the phone with a lock configured: a PIN-only
    record offers fingerprint enrollment right after a PIN unlock; from then
    on reopening the PWA raises the fingerprint sheet by itself (or shows the
    button on iOS), a fingerprint alone unlocks, cancelling it leaves the PIN
    path working, a fresh setup on a biometric-capable phone states
    PIN-as-fallback
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — no Google "Use passkey?" sheet before the
    fingerprint (2026-09-26). The credential is now device-bound
    (`BIOMETRIC_SELECTION`, `residentKey: "discouraged"`, `client-device`
    hint) instead of a Google Password Manager passkey; an old passkey record
    is re-enrolled once after the next unlock (one extra fingerprint touch),
    and the old passkey is signalled away (`signalUnknownCredential`). On
    Android Chrome: after that one upgrade, locking and reopening goes
    straight to the fingerprint, and the passkey no longer shows in Password
    Manager
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — branded fingerprint wait (2026-09-27,
    `mobile.lock.brandedSheet`). Android's sheet cannot be restyled, so the
    lock screen dresses the space above it: while the sheet is up the form
    steps aside, the mark lifts and grows with its rings turning and "Touch
    the fingerprint sensor" breathing under it; on success the mark flares
    gold and lifts away (~0.5 s) before the app opens. Check that nothing
    sits under the sheet, a cancelled sheet brings the form back, and the
    PIN unlock plays the same flourish
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31m — Mobile to-do board: sticky filters, FAB, hide archived**
  (2026-08-30; ✅ Code-complete, ⚠️ needs live QA on a phone).
  Four changes to `mobile-web/src/screens/Todo.tsx`. **"Hide done" is
  remembered** (`mobile-web/src/prefs.ts`, `localStorage` under
  `tabtivity.mobile.*`) — the screen is remounted by every tab switch, so the
  toggle was being re-ticked a dozen times a session; the search and the two
  pickers stay transient on purpose, since a filter that outlives the visit
  hides cards nobody chose to hide. **"Hide archived" is new and defaults
  on**: it hides cards resting in a column flagged `archived`, which "hide
  done" cannot reach (an *abandoned* archived card has `percent < 100`). That
  flag had to be added to the bridge — `protocol::TodoColumn.archived`
  (`#[serde(default)]`; the struct is `deny_unknown_fields`, so the desktop
  could not have sent it otherwise) and `MobileBridgeHost`'s snapshot — and is
  read off the flag, never the column's name, so a rename cannot change what
  the filter hides. **Add card is a FAB** floating above the tab bar (z-index
  between the bar and the editor backdrop); + Column stays as a small button
  at the top. **The search moved directly under the header** and the "synced
  through the desktop" notice to the foot of the screen. Tested in
  `src/__tests__/mobile/MobileTodoBoard.test.ts`.
  - [ ] 🖐️ Manual test — on the phone: tick "Hide done", leave the board and
    come back (still ticked); the board opens with archived cards hidden and
    the archive column still showing its count; unticking "Hide archived"
    reveals them and is remembered; the ＋ button adds a card and never sits
    under the tab bar or over the editor; the last column is fully scrollable
    past the button
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31t — Rename an agent tab from the phone** (2026-09-02; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending). A tab's name was the one
  thing the phone could read but never change, so a session opened from the sofa
  stayed "Claude" until the laptop was reachable. Each agent row on the project
  screen now carries a ✎ beside its ◷, opening a sheet that renames the tab
  through `PUT /api/v1/tabs/{id}` — authenticated, exact-origin, agent tabs only
  (`host::agent_tab_target`, the same resolver the schedule routes use). The
  sidecar owns no tab layout, so the write is a desktop-bridge call
  (`DesktopRequest::RenameTab`) that lands in `renameTabInScope`; the reply
  carries the label the desktop actually stored, and the route answers with the
  freshly-loaded catalog row so the list shows the new name without waiting a
  poll. A label is refused rather than silently rewritten when it is blank,
  longer than the catalog's 120-character publish cap, or carries control
  characters that would reach a terminal title verbatim — checked on both sides
  of the bridge, because the bridge is reachable without the route. Same
  composer-chip fix in passing: Model/mode/Schedule are flex containers with no
  `justify-content`, so a shrunk chip held its label against the left edge, and
  `text-overflow` never applied to a flex container's anonymous text — the
  labels now sit in a `.composer-chip-label` that centers and ellipsizes. The
  embedded PWA is compiled in, so this needs a rebuild + restart to reach a
  phone. Locked by `MobileTabRename.test.tsx` and the `host.rs` rename route
  test.
  - [ ] 🖐️ Manual phone QA — rename an agent tab from the project screen and
    watch the desktop tab title follow; reopen the PWA and see the new name;
    confirm a blank name cannot be saved and an over-long one is refused; with
    desktop Tabtivity closed the sheet says to open it rather than failing
    silently; no ✎ appears on a shell tab; check the Model/mode/Schedule chips
    read centered in a narrow terminal.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31be — Close a tab from the phone** (2026-09-05; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending — and a rebuild + restart first:
  the sidecar route, the desktop bridge and the embedded PWA all changed). The
  phone could open tabs and never put one away, so a week of sofa sessions
  piled up as rows that only the laptop could clear. Every tab row on the
  project screen now carries a ✕ beside 31t's ✎ — **shell rows too**, which is
  where this parts from its neighbours: rename, schedules and the status chip
  are agent surfaces, and a shell tab is exactly as closeable as an agent one,
  so `host::tab_target` grew an `agent_only` flag and the agent-only routes
  pass `true` where `DELETE /api/v1/tabs/{id}` passes `false`.
  - **Closing is the desktop's ×, and nothing stronger.** The tab leaves the
    layout and its viewer dies; the tmux session behind it keeps running and
    stays reattachable from the desktop's Sessions view — `lib/remote/closeRemoteTab`'s
    rule, applied rather than restated. A tap on a phone must not be able to
    end a running agent, which is also why the sheet says so in place of a
    yes/no confirm, and why the plan's deferred "tab termination" is still
    deferred: this is a *layout* action.
  - **The write is aimed at a named scope.** `removeTab` writes to whatever the
    desktop window is showing, and the phone is regularly looking at another
    project — so `useTabsStore.removeTabInScope` closes in the scope the request
    names, handles a tab living in a popout the way `closeDetachedGroup` does
    (its pane is mounted in that window, so nothing else would kill its PTY),
    and falls through to `removeTab` for the ordinary same-scope case.
  - **And it reaches disk.** CenterPanel's debounce persists the *active* scope
    only, so a close in a project the desktop is not showing would never be
    written and the phone's own catalog — which is read out of
    `sessions/<id>/terminals.json` — would list the closed tab for ever. The
    bridge writes the scope itself (`persistScopeLayout`, `stores/agents/agentSchedules`'
    `persistScheduleBinding` renamed to what it always did, since a rename from
    the phone needed the same write and never made it). A project the desktop
    has not restored this session is restored first through
    `restoreProjectScope`, which reads that same file **without** activating the
    project: the user's window stays where they left it, and an inactive
    project's panes are not rendered, so nothing spawns a terminal on the way.
  - An open phone terminal on a closed tab is torn down within five seconds by
    `pty_bridge`'s existing authorization tick, which stops finding the tab in
    the catalog. Locked by `MobileTabClose.test.tsx` (store, bridge and screen)
    and the `host.rs` close-route test, which closes a *shell* tab and checks
    the agent-only routes still refuse one.
  - [ ] 🖐️ Manual phone QA — on the project screen press ✕ on a shell tab: the
    sheet names the tab and says the session keeps running; Cancel closes
    nothing; Close tab drops the row and the tab disappears from the desktop
    window; the same for an agent tab, in a project the desktop is *not*
    currently showing, and the desktop's tab strip loses it there too; relaunch
    Tabtivity and the closed tab does not come back; with a phone terminal open on
    a tab, close that tab from the desktop and watch the phone say the session
    is gone rather than hanging; with desktop Tabtivity closed the sheet says to
    open it rather than failing silently.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bf — Mobile status chip: the session's state and the agent's own usage**
  (2026-09-02; ✅ code-complete and automated tests passing, ⚠️ phone QA
  pending — and a rebuild + restart first, since the phone serves the bundle
  baked into the binary). A **Status** chip joins ＋ / model / mode / ◷ Schedule
  on the agent composer, carrying the tab's own lamp, and opens a sheet with the
  same **Formatted | Terminal** switch the header uses for the session itself.
  - **Two sources, deliberately.** The state (working / waiting on you /
    finished / idle) and today's tally are the *desktop's* and cost nothing —
    the activity store's classification of that tab's output, and
    `usage_summary`'s counters. The quota panel is the *CLI's*, read by running
    `claude -p "/usage" --output-format json` once
    (`src-tauri/src/services/agent_usage.rs`). That run is client-side —
    `num_turns: 0`, zero tokens, ~0.5s — so asking how much quota is left
    spends none, which is the whole reason a phone may trigger it. Claude Code
    is the only recipe: `/status` is not available in print mode and no other
    CLI documents a non-interactive usage readout, so every other agent is
    reported **unsupported** rather than shown an empty panel.
  - **The raw text is always one tap away.** The panel travels exactly as the
    CLI printed it (ANSI stripped, 8 KiB cap that marks its cut) and
    `mobile-web/src/terminal/usageReport.ts` is the only thing that parses it —
    positive matches only, a line nothing claims kept as a note, and a panel
    nothing claimed at all reported as unrecognized *with* the raw block. A
    release that reshapes the format costs the reader a nicer layout, never the
    figures.
  - **The tally is labelled at the grain it is recorded.** `agent.prompt.<cmd>`
    is this agent's; worked seconds, decisions and finished turns are the
    *project's* — every agent tab in it — and the sheet says so rather than
    attributing all four to the agent it is about.
  - Bounds: a 60s desktop cache, a 10s floor under the sheet's own Refresh (so
    holding the button cannot spawn a process per tap), and one deadline per
    hop, each above the one below it — CLI 15s < desktop 20s < sidecar 25s <
    phone 30s. The three copies of the mail-message timeout `matches!` became
    `DesktopRequest::response_timeout`/`desktop_timeout` on the way.
  - Tested in `src/__tests__/mobile/MobileUsageReport.test.ts` (7) and
    `src/__tests__/mobile/MobileStatusSheet.test.tsx` (7), plus the service's own Rust
    tests.
  - [ ] 🖐️ Manual phone QA — on a Claude tab: the Status chip shows the tab's
    lamp and opens with the session state, the model/mode/context the composer
    already reads, and the 5h + weekly bars with their resets; Terminal shows
    the same panel as the CLI printed it; Refresh re-reads (and says "Cached"
    when it did not); on a Codex tab the sheet still shows the state and the
    tally but says Codex has no readable usage; with desktop Tabtivity closed it
    names Tabtivity rather than "request failed"
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31v — Mobile Focus stops above the session's own input box**
  (2026-09-02; ✅ code-complete and automated tests passing, ⚠️ phone QA pending
  — and a rebuild + restart first, since the phone serves the bundle baked into
  the binary). Every agent TUI pins the same block to the bottom of its screen:
  a labelled rule, the input box, the statusline, and a hint line naming keys a
  phone has no way to press. Focus painted all of it, so on a Claude Code
  session with a custom statusline four lines of chrome sat under every answer
  and pushed the reading the user came for off the top of a phone screen — while
  the composer right below it *is* that input box and its chips already carry
  the path, branch, model, mode and context. `inputFrameStart`
  (`mobile-web/src/terminal/statusLine.ts`, beside the parser that reads those
  same lines into the chips) returns where the frame begins and the reading view
  cuts there; Copy copies what is left. The scoping is `sessionStatus`'s — agent
  tabs only, the last 8 lines only — plus one guard: a select dialog's rows open
  with the input line's own marker (`❯ 1. Yes`), and hiding a question the
  session is waiting on would be the one unrecoverable mistake here, so a
  numbered row means no frame and nothing is cut. Blank rows and the box's
  labelled top rule directly above go with it, or the output would trail off
  into a rule and a gap. Tested in `src/__tests__/mobile/MobileSelectPrompt.test.ts`
  (3 cases).
  - [ ] 🖐️ Manual phone QA — open a Claude agent tab in Focus: the answer ends
    at the last real output line, with no rule, no `❯`, no statusline and no
    "auto mode on" hint under it; the model/mode/context chips still read
    correctly; Copy copies without the chrome; when the agent asks a permission
    question the numbered options stay visible and answerable; Terminal view is
    unchanged; a shell tab is unchanged.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31s — Mobile Terminal view reaches the whole session** (2026-09-02;
  ✅ code-complete and automated tests passing, ⚠️ phone QA pending). tmux sizes
  a window to its widest attached client, so the bridge hands the phone the
  desktop's geometry (`pty_bridge::window_size`) rather than a cursor-following
  slice — but Terminal view then clipped it: `.terminal` was `overflow:hidden`,
  so everything past ~44 of ~180 columns was simply unreachable, and only Focus
  view (which re-wraps) could show it. The terminal element is now the
  horizontal scroller its own `touch-action:pan-x` always implied, and `.xterm`
  grows to `max-content` so xterm's cols-wide `.xterm-screen` has somewhere to
  overflow *into* and the themed background follows the panned-to columns.
  Vertical drags still scroll history: `terminal/touchScroll.ts` decides the
  axis once per gesture and hands a sideways drag back to the browser —
  necessary for the Touch Events fallback, whose `preventDefault` would
  otherwise eat the pan — and takes pointer capture only after a drag proves
  vertical. Because a phone draws no scrollbar at rest, `terminal/wideOutput.ts`
  fades whichever edge still hides output (a `ResizeObserver` catches the
  desktop widening the window mid-session).

  The **rows** are adopted from the same window, so the fold cut the other axis
  too, and there it hid the *newest* output: a 50-row screen in a ~20-row box
  left the live prompt permanently below the edge, unreachable — scrolling the
  buffer only moves history through the same clipped screen. The view now opens
  anchored to the last rows, and the vertical drag consumes the hidden rows
  before it reaches the scrollback, so one gesture runs continuously over
  `[scrollback] + [rows below the fold]`. A session that fits has no overflow to
  consume and scrolls history from the first pixel exactly as before, and only a
  changed row count re-anchors, so a reader panned up keeps their place. The
  embedded PWA is compiled in, so this needs a rebuild + restart to reach a
  phone. Locked by `MobileWideOutput.test.ts` and
  `MobileTerminalTouchScroll.test.ts`.
  - [ ] 🖐️ Manual phone QA — with a desktop-width tmux window, open Terminal
    view on a session with long lines: a sideways drag pans to the end of the
    line and back, an up/down drag still scrolls history (not the pan), the
    right edge fades while output continues past it and stops fading at the far
    right; Focus view shows no fades and still re-wraps; widening the desktop
    window mid-session brings the right fade back.
  - [ ] 🖐️ Manual phone QA (rows) — with a desktop window taller than the phone
    shows, Terminal view opens on the live prompt, not on the middle of the
    screen; dragging down reveals the rows above it and then runs on into
    scrollback without a jump; dragging back reaches the prompt again; a short
    session (desktop window no taller than the phone's box) scrolls history from
    the first pixel as before.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31bg — Mail writes from the phone: mark read/star and reply-only**
  (2026-09-03; ✅ code-complete and automated tests passing, ⚠️ phone QA
  pending). Mail was the one companion surface with no write at all, and the
  reason was the outbound threat model, not the architecture. Two writes now
  exist behind two separate default-off switches in Settings → Tabtivity Mobile
  → *Mail from the phone*: `mail_actions` (mark read/unread, star/unstar via
  `POST …/messages/:id/mark`) and `mail_reply` (a plain-text reply via
  `POST …/messages/:id/reply` where the phone supplies only the text — the
  desktop derives recipient, subject, quote and `In-Reply-To` from the
  original, so a phone can answer people who already wrote and nobody else).
  Both are gated on the desktop bridge (`MobileBridgeHost`), never in the
  sidecar; the overview reports `actions`/`reply` so the phone hides the
  controls rather than discovering a refusal. Delete, move, fresh compose,
  attachments and OpenPGP stay on the desktop.
    - [ ] 🖐️ Manual test — both switches off: open a message on the phone;
      expect no Mark/Star buttons and no reply box, and the read-only notice.
    - [ ] 🖐️ Manual test — `mail_actions` on: Mark read / ★ Star on the phone;
      expect the row to update from the desktop's answer and the desktop mail
      client to show the same state after its next sync.
    - [ ] 🖐️ Manual test — `mail_reply` on: type a reply, tap *Send reply…*,
      expect the confirmation naming the sender's address; confirm; expect
      "Reply sent from the desktop", the ↩ mark on the row, the reply in the
      desktop's Sent folder threaded under the original, and the mail to
      arrive at the sender.
    - [ ] 🖐️ Manual test — flip a switch off while the phone has the message
      open; tap the control; expect the "Switched off in Tabtivity" explanation.
- [x] **31bh — The phone's `done` tag clears when the tab is read** (2026-09-02;
  ✅ verified live on the phone 2026-09-20). The
  `done` pill on the project screen is the desktop's own attention flag, and
  nothing on the phone ever retired it: opening the tab, reading the finished
  turn and backing out left the pill exactly where it was, so every tab the
  agent had ever finished a turn in stayed flagged until somebody switched to
  it on the laptop. Attaching a terminal now reports the tab seen
  (`DesktopRequest::TabSeen` → `clearAttention`), and so does detaching — the
  two edges of "it was on the phone's screen" — which is the same door the
  desktop's own tab switch uses: the output counts as read, and a live decision
  prompt deliberately survives it, because being looked at is not being
  answered. Fire-and-forget from the sidecar, so a wedged desktop cannot hold
  up the attach, and shell tabs (which raise no flag) send nothing. The
  composer's status lamp stops showing a stale `done` for the tab being read,
  since its row is frozen for the whole session. Backend + desktop change: this
  needs a rebuild + restart, and the embedded PWA is compiled in. Locked by
  `MobileTabSeen.test.tsx`, `MobileTerminalStatusLamp.test.tsx` and the
  `protocol.rs` seen-request test.
  - [ ] 🖐️ Manual phone QA — verified live 2026-09-20 on the running dev
    build: a finished Claude tab reported `done` by the desktop's own catalog
    answer dropped out of it one poll after the phone opened it, and the tab's
    finished ring was gone on the desktop tab bar. Traced with a same-user
    client on `desktop-control.sock`: a hand-sent `TabSeen` answers `seen` and
    retires the tag, and the phone's own attach does the same. Still unchecked:
    a `question` pill surviving a look, and attaching with desktop Tabtivity
    closed.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [x] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31r — The phone comes back where it was** (2026-09-02; ✅ code-complete
  and automated tests passing, ⚠️ phone QA pending). Tabtivity Mobile saved only
  the terminal it was last *sent into* (`rememberLastTab` fired on the way in
  and nothing ever fired on the way out), so one visit to a terminal became
  every later cold open's landing screen — backing out of it, or spending the
  session on the To-do board, changed nothing. The slot now holds the whole
  place (`mobile-web/src/lastPlace.ts`): the tab-bar section, and under
  Projects the project and the terminal on top of it, if any. It is derived
  from the app state in an effect rather than written by one navigation, so
  leaving a terminal or switching sections records the departure too. A saved
  tab the host no longer has degrades to that project's tab list instead of
  dropping the reader on the project list. The old `{projectId, tabId}` value
  still reads back as the terminal it named, so an update does not lose a
  phone's place. The embedded PWA is compiled in, so this needs a rebuild +
  restart to reach a phone. Locked by `MobileLastPlace.test.ts`.
  - [ ] 🖐️ Manual phone QA — open a terminal, back out of it, close and reopen
    the PWA: it lands on that project's tab list, not in the terminal; leave
    the app standing on To-do (or Calendar/Mail) and reopen: it lands there;
    open a terminal and reopen while it is open: it lands in the terminal;
    close the desktop tab and reopen the PWA: it lands on the project.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31q — Mobile collected prompts** (2026-09-02; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending). "◷ Collected prompts" on the
  project screen opens the project's tab-free prompt list (desktop #249)
  through project-scoped, authenticated, exact-origin routes
  (`/api/v1/projects/{id}/prompts[/{prompt_id}[/send]]`). *Send now* posts an
  opaque agent-tab id; the sidecar checks the tab belongs to the same project
  and is an agent tab before the desktop turns the prompt into a one-time
  schedule at **its** current minute — the phone never computes desktop time.
  *Schedule…* opens the per-tab sheet (31p) prefilled. The embedded PWA is
  compiled in, so this needs a rebuild + restart to reach a phone. Locked by
  `MobileProjectPrompts.test.tsx` and the `host.rs` prompt route test.
  - [ ] 🖐️ Manual phone QA — add/edit/delete a prompt and see the desktop
    Agents view follow; Send now to an idle agent and watch it typed on the
    desktop; Schedule… lands in the tab sheet with the text; with desktop
    Tabtivity closed the sheet disables writes and says so.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31p — Mobile per-tab schedule sheet** (2026-09-01; ✅ code-complete and
  automated tests passing, ⚠️ phone QA pending). Every agent tab on the
  project's tab overview carries its own schedule line and a **◷ Schedules**
  button, which manage one-time/daily/weekday definitions through authenticated
  opaque-tab endpoints. The phone sees the desktop time zone but never the raw
  project id, tmux name, path, or schedule target id. With the sidecar still
  reachable and desktop Tabtivity closed, terminal access remains available while
  the sheet disables writes and says to open desktop Tabtivity.
  - 2026-09-02 fix: "Schedules could not be loaded" / save failing on the phone
    was the desktop answering `tab_not_found` for every restored agent tab —
    the restore path computed the schedule target id on its resume-check helper
    object and never put it on the tab entry (see group-s). Not yet re-verified
    on a phone; the embedded PWA needs a restart to pick up the moved control.
  - 2026-09-02: scheduling now lives **only** in the project tab overview, the
    way the desktop Agents view has it — the terminal's `◷ Schedule` composer
    chip is gone, and each agent tab prints the desktop's own summary line
    ("2 of 3 scheduled · next 09-03 09:00") beside ✎ Rename and ◷ Schedules.
    The summary rides with the catalog response (`AgentTabSchedules`), so the
    overview stays at one round trip per poll. Needs a rebuild **and** a
    desktop restart: both the sidecar and the bridge changed.
  - [ ] 🖐️ Manual phone QA — CRUD a schedule and see the desktop dialog/indicator
    refresh; edit it on desktop and see the open sheet refresh; close desktop
    Tabtivity and verify the explanatory disabled state without losing terminal
    access; verify auth/origin rejection from an unpaired client.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ah — The phone's PWA updates on commit, without a relaunch** (2026-09-17;
  ✅ code-complete, automated tests passing and the publish→load contract smoke-tested
  end-to-end, ⚠️ not verified on a phone — and the first pickup costs exactly one
  relaunch, since the overlay support is itself compiled in). The bundle is baked
  into the binary (`build.rs` embeds `mobile-dist/`) and the running window keeps
  its old inode across an install, so freezing a commit never reached the phone
  until the user relaunched: on 2026-09-17 the sidecar was serving
  `index-BxC6mmm7.js` while the installed binary held `index-B6ra4vC5.js` and the
  tree held a third.
  - `scripts/package-dev.sh` now publishes the bundle it just built into
    `target/mobile-pwa/` with a `.stamp` (`built`, `commit`, `entry`), and
    `services::mobile_control::live_pwa` serves that instead of the embedded copy.
    In `--head` mode it publishes **before** cargo starts, so a commit reaches the
    phone in seconds rather than after the two-minute compile. Written under
    `target/` rather than `$HOME` on purpose: commits come from agent tabs, where
    `agent_fence` replaces `$HOME` with a tmpfs that dies with the tab — the same
    trap that made the binary install silently evaporate (2026-09-04).
  - Three guards: opt-in at compile time (`TABTIVITY_MOBILE_LIVE_DIR`, set only by
    `package-dev.sh` and `start-tabtivity-tauri-hotreload.sh`, so a released binary
    has no overlay path at all); never backwards (an overlay older than
    `MOBILE_ASSETS_BUILT_AT` is refused, so a stale branch cannot shadow a fresh
    binary); all-or-nothing (a bundle missing its shell or its stamped entry is
    refused whole, since mixing two bundles is a white screen).
  - **Open:** the overlay carries the PWA, not the sidecar's HTTP API. A mobile
    feature whose backend half is not in the running window will now *render* and
    then fail its request, where before it simply was not there. `backend:stale`
    reports that gap ("THE PHONE IS AHEAD OF THE RUNNING BACKEND") rather than
    hiding it, and a relaunch is the same remedy as before.
  - [ ] 🖐️ Manual phone QA — commit anything touching `mobile-web/`, wait for the
    post-commit freeze, pull-to-refresh on the phone and confirm the build stamp
    in the UI moved without the desktop being relaunched; then confirm
    `npm run backend:stale` names the published bundle.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ai — The phone says what each session was last asked** (2026-09-18;
  ✅ code-complete, automated tests passing, ⚠️ not verified on a phone). Every
  agent tab on the phone is called "Claude", and until now the only reading that
  told two of them apart was a status word. A session's card in a project now
  carries its **last prompts, always open** — the newest first and given room to
  wrap, up to four older ones on one line each — and a row in the flat Agents
  list carries the last one under its label. No disclosure control: an expander
  answers "which tab did I set on the docs" one tap at a time, which is the work
  the line exists to save.
  - The reading is the desktop's own and costs no new read. `stores/agents/agentModels`
    already tails each agent's transcript for the model pill and the Agents
    view's "last prompt:" line (`agent_tab_recent_prompts` →
    `agent_session_recent_prompts`), so the tail is simply kept
    (`recentByTab`) instead of being reduced to its last entry, and rides the
    catalog/activity answer as `AgentTabPrompts` the way the schedule summary
    rides it. However a prompt was submitted — typed into the TUI, pasted, sent
    from the phone, delivered by a schedule — the transcript has it.
  - Published for a **quiet** tab too, which is the one asymmetry with the status
    rows beside it: `projectAgentStatuses` drops an idle tab before its own
    refresh (right for the Agents list, which deliberately lists nothing quiet),
    and the session nobody has prompted since this morning is exactly the one
    whose last prompt is worth reading. A prompt line is not a claim that
    anything is running.
  - Bounded twice — the desktop sends at most 5 prompts of 240 characters, and
    the sidecar re-applies both at the browser boundary, since the far side is
    someone else's build. Timestamps are the transcript's own ISO instants,
    formatted in the **phone's** zone rather than sliced like the desktop-local
    schedule string.
  - Needs a rebuild **and** a desktop restart: the sidecar, the bridge and the
    PWA all changed.
  - [ ] 🖐️ Manual phone QA — open a project with two agent tabs, confirm each
    card lists its own recent prompts newest-first with the last one legible;
    type a prompt straight into a tab on the desktop and confirm it appears on
    the phone within a poll; leave a tab idle for an hour and confirm its card
    still shows what it was asked; check the Agents list carries the last prompt
    under each row; check an agent with no readable transcript (Gemini/Qwen)
    shows its screen-echoed line rather than an empty block.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

---

- [~] **31aj — Mobile Focus reads an OpenCode session** (2026-09-18; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). Plain
  `opencode` is a full-screen TUI and Focus hands it to the Terminal view; its
  **minimal interface** (`opencode --mini`) writes scrollback instead, and Focus
  rendered that as a wall: every tool call in full, the start-up banner, the
  turn footer, and OpenCode's own live status row painted into the
  conversation — while the composer's model, mode and status chips stayed
  empty, because a mini frame has no `>` input box for `statusLine` to anchor
  on. Everything below was read off captures of a real 1.18.31 session replayed
  through the phone's own emulator at 60/80/100 columns, not out of the bundle;
  `mobile-web/src/terminal/openCodeMini.ts` holds the shapes and the reasoning
  for each.
  - **The frame** is found by its status row (` BUILD   223.0K (21%) · ctrl+p
    cmd`), the last non-blank row of every mini frame, scoped to a tab whose
    label names OpenCode — the same tie-break `agentModes` uses, and the only
    thing that tells a bare ` BUILD` from a line of output. The box above it
    (blanks, and its `Ask anything…` placeholder) goes with it; a draft typed on
    the desktop stays in the reading view, the harmless direction.
  - **The chips**: the agent in capitals is the mode, `223.0K (21%)` the
    context, and the model comes from the turn footer `▣ Build · Muse Spark 1.3
    Free · 6.2s` — the one place a mini session prints its display name — or
    from the `model <id>` notice the status row shows right after a switch.
  - **The turns**: the banner, the turn footer and each tool call (`→ ✱ ◈ %
    ✗`, `# … Task`) are dropped the way Claude Code's tool calls are; the bash
    tool's `$ cmd` and its output stay, being the session's own words. OpenCode
    **wraps its own rows**, so a block is held together by the blank row that
    ends it rather than by an indent — that is what keeps a wrapped prompt in
    one bubble and drops a wrapped `✱ Grep …` whole instead of stranding its
    tail as the agent's first answer line.
  - **Its wrapping is undone** with the pane's own column count, so the phone
    re-wraps at its width — what `readableScreen` does for every other CLI by
    rejoining the rows xterm wrapped. A break is only undone when the wrap
    explains it (the row ran into the last column, or the next word would not
    have fitted), and the seam is read the same way: a space the wrap kept
    comes back, a long token broken at its own `/`, `-` or `.` is rejoined with
    nothing between.
  - **Mode is a readout.** `opencode --mini` binds no key that switches its
    agent — Tab, Shift+Tab and the leader keybinds belong to the full-screen
    TUI and do nothing in mini, and its ctrl+p palette offers "Switch model"
    and "Variant cycle" only (verified against 1.18.31). The family is marked
    `fixed`: the sheet lists Build and Plan with the current one marked and says
    the agent is settled at `--agent` time, and the chip presses nothing.
  - **Model works.** Mini has no `/model` — sending one would submit the word to
    the model as a prompt, a turn nobody asked for — so the chip opens
    OpenCode's own picker through the palette (ctrl+p, `model`, Enter) and the
    sheet lists the rows it drew. A tap answers by typing into the picker's
    search field (ctrl+u, the row's label, Enter), which is how a person uses
    it; tapping one of its group headings narrows the list, which the sheet
    reads as the next step. Verified end-to-end against a live session locally,
    never on a phone.
  - The alt-screen notice now names `--mini` for an OpenCode tab, which is the
    only way into any of this.
  - [ ] 🖐️ Manual phone QA — start a tab with `opencode --mini`, ask it
    something that uses tools, and confirm: the chat shows prompts and answers
    with no tool rows, no banner and no ` BUILD` row; paragraphs re-wrap to the
    phone rather than breaking at the pane's width, with URLs and paths intact;
    the mode chip reads Build and its sheet explains it cannot switch; the model
    chip opens OpenCode's picker and a tap changes the model (the next turn's
    footer names the new one); the status chips show the context percentage; a
    left→right swipe shows the ` BUILD …` status row; a plain `opencode` tab
    still offers the Terminal view with the `--mini` hint.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] **Follow-ups**: model *variants* (ctrl+t, OpenCode's reasoning-effort
    equivalent) have no chip yet; a stored-session reader for
    `~/.local/share/opencode/opencode.db` would give Focus a history that
    reaches past the pane's scrollback (see the survey).

---

- [~] **31ak — Arrange a project's tabs by hand from the phone** (2026-09-18; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). The
  phone could sort its agent tabs (last working, last done, arrival) and could
  not *place* them: the flat Agents list had the picker, a project screen had no
  control at all, and neither had a way to say "this one belongs above that
  one". A project's tab list now carries the same three-way picker, with the
  arrival order named **Manual (tab order)** — because on this screen that order
  IS the desktop's tab bar — and under it every card grows a **⠿ grip** that
  drags it into place.
  - The order it writes is the desktop's own, not a phone-local preference. A
    drop is `PUT /api/v1/tabs/{id}/order` with the anchor tab's opaque id and a
    side, which the sidecar turns into `DesktopRequest::ReorderTab`; the bridge
    runs `reorderTabInScope` — the same store action the desktop Agents view's
    drag calls, so the flat scope order and, where both tabs share a layout
    group, the tab bar itself move together — then persists the scope's layout
    before answering, because the route reads the new order back out of the
    catalog's own session file.
  - Offered under the manual order alone. The other two are computed from what
    the agents did, so a dropped row would spring back the next time one of them
    worked; the desktop's drag follows the same rule.
  - Both tabs cross as opaque ids and must resolve to one scope
    (`tab_scope_mismatch`): two projects have two layouts and no shared order a
    move could be expressed in. A tab dropped on itself is refused before any
    desktop call.
  - The list rearranges on the drop and reconciles with the order the desktop
    answers with; a refusal puts the row back and says to open desktop Tabtivity.
    The 5 s poll is paused across the write, or a reply carrying the pre-drop
    order would yank the card back for a second.
  - The grip's arrow keys move a tab one place, since a drag is reachable by
    neither a keyboard nor a screen reader, and the page scrolls itself when the
    finger reaches either edge — a list of ten tabs is taller than the phone.
  - The cross-project **Agents** list is deliberately untouched: its rows span
    projects, so there is no one tab bar for a manual order to be written into.
  - Needs a rebuild **and** a desktop restart: the sidecar, the bridge and the
    PWA all changed.
  - [ ] 🖐️ Manual phone QA — open a project with three or more tabs, pick
    **Manual (tab order)**, drag a card to the top and confirm the Tabtivity
    window's tab bar moved with it; confirm the order survives a pull-to-refresh
    and a relaunch; drag a card past the bottom of the screen and confirm the
    page scrolls under the finger; switch to **Last working** and confirm the
    grips disappear; close desktop Tabtivity and confirm a drag reports "Open
    desktop Tabtivity to rearrange tabs" and puts the card back.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31al — Codex and Claude read alike on the phone** (2026-09-19; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone).
  - Claude Code 2.1.278 dropped "esc to interrupt" from its spinner
    (`✶ Cascading… (36s · ↓ 2.1k tokens)`), so the Session view's "working"
    row never showed for Claude; `agentBusy` now reads that row by its shape.
  - Codex 0.155 animates one-dot braille sparkles over its composer; one next
    to `›` hid the input box, so Focus's frame cut and the facts flipped every
    repaint (the flicker). `readableScreen` reads those eight cells as blank.
  - Codex's facts row now matches Claude's: context left and the 5h/week
    windows come from its rollout's `token_count` events
    (`agent_transcript::TranscriptUsage`), and no fact row shows the project
    path any more.
  - Codex's "Last prompts" on the tab cards: the prompt reads looked only at
    the last 512 KB, and a Codex turn writes each tool result twice, so a busy
    session's prompt fell out of it. The prompt reads now widen to 16 MB.
  - OpenCode cards showed their TUI's panels as "prompts" (the screen-echo
    fallback misreads its full-screen frame); that fallback is gone for
    OpenCode. Instead the phone reports each composer prompt as it sends it
    (`POST /api/v1/tabs/{id}/prompt` → `DesktopRequest::TabPrompt`), the desktop
    records it in the tab's prompt history, and a tab whose transcript is not
    read lists its history rows. Empty, the card says prompts sent from Tabtivity
    show there. Claude/Codex rows dedupe against transcript adoption.
  - Needs a rebuild **and** a desktop restart (backend + embedded PWA).
  - [ ] 🖐️ Manual phone QA — prompt a Claude tab, open it in Focus → Session:
    the "Working" dots show until the turn ends. Open a Codex tab in Focus
    while it works: no flicker, the composer frame stays cut, and the row
    under the output shows model · mode · `NN% context` · `5h NN%` ·
    `week NN%`, no path. Back on the project screen, the Codex card's "Last
    prompts" names the prompt it is working on. Send a prompt to an OpenCode
    tab from the phone: its card lists it (with the time) after the next poll,
    and the desktop prompt chart shows it once — also for a Claude tab.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31am — The agent's files live in a gallery, not in the chat** (2026-09-20;
  ✅ code-complete, automated tests passing, ⚠️ not verified on a phone).
  - What `tabtivity-send` puts in `.tabtivity/outbox/` no longer renders in the
    Focus chat, and the **From the agent** strip above the composer is gone:
    a picture between the turns buried the answer that mentioned it, and the
    chat rewrote itself every time a file arrived.
  - Instead a button beside the tab name counts what the agent sent and opens
    the gallery (`mobile-web/src/components/OutboxGallery.tsx`): a grid of
    thumbnails and file cards, newest first, in both Focus and Terminal. A tap
    opens the file full screen (`OutboxViewer`, unchanged: save, share, inert
    text, PDFs in a new tab, other kinds as downloads) and ✕ lands back on the
    grid. The strip's ✕ ("hide these files") is gone with it — nothing to
    dismiss when nothing intrudes.
  - `terminal/outboxTimeline.ts` (which placed a file after the turn it
    followed) is deleted; `terminal/fileLabels.ts` now holds the age/size
    wording the composer and the gallery share.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a
    desktop restart to serve it.
  - [ ] 🖐️ Manual phone QA — on a tab whose agent ran `tabtivity-send`: the chat
    holds turns only (no pictures, no cards), and the button beside the tab
    name shows the count. Tap it → the grid, newest first → tap a picture →
    full screen → ✕ → back on the grid → ✕ → back to the chat. Switch to
    Terminal → the same button, no strip above the composer. Send another file
    → the count rises within ~8 s without the chat moving.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31an — Arrange the phone's project list by hand** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). The
  Projects list came in the host's order only — live sessions first, then last
  activity, then name — so the two projects a day is spent in kept swapping
  places under the thumb. Every row in the **Active** list now carries the same
  **⠿ grip** the tab cards wear, and drags into place.
  - The order is **this phone's**, not the desktop's: it is a `localStorage`
    preference (`prefs.ts` → `readOrder`/`writeOrder`, `projectOrder.ts`), so a
    drag needs no desktop Tabtivity, cannot be refused, and leaves the Tabtivity
    window's own project pills exactly where their owner put them. Unlike 31ak
    (tab order), nothing crosses the bridge — no route, no sidecar, no protocol
    change, and no desktop restart is needed for it.
  - The host's order stays the fallback: a project that has never been placed
    keeps it and follows the placed ones, which is also where a project that has
    only just become active arrives rather than in the middle of an arranged
    list. A project the list is not carrying right now (its sessions ended)
    keeps its stored place around the block of listed rows, so an unrelated drag
    does not demote it (`mergeProjectOrder`).
  - Grips are drawn in the **Active** list only, and only with more than one row:
    a search result is an answer to a query, where the best match belongs at the
    top. The stored order is capped at 200 ids.
  - The drag itself is now one implementation for both lists
    (`mobile-web/src/rowDrag.ts`, lifted out of the project screen): pointer
    captured to the grip, edge scrolling, and the arrow keys for a keyboard or a
    screen reader. The project screen's tab drag is unchanged in behaviour.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — with three or more active projects: drag the
    bottom row to the top and confirm it stays there through a poll, a trip into
    a project and back, and an app relaunch; confirm the desktop's project pills
    did **not** move; hold a grip and drag past the bottom edge and confirm the
    page scrolls under the finger; switch to **Search**, confirm no grips;
    start a session in a project that was not listed and confirm it joins the
    end rather than jumping into the arranged block.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

---

- [~] **31ao — A question in Focus is a list to tap, not a highlight to walk**
  (2026-09-20; ✅ code-complete, automated tests passing, ⚠️ not verified on a
  phone). The stored session cannot carry a choice the agent has not been given
  yet, so Focus → Session shows the live screen under it ("On screen now").
  It showed the dialog as **text** — Claude's permission prompt, an
  `AskUserQuestion`, Codex's approval — rows and all, answerable only by
  walking the highlight with the arrow keys, which is what the phone has no
  room for.
  - The rows are now a list (`QuestionList`), numbered as the dialog numbered
    them, each row a tap. What sits *above* the rows — the question and
    whatever the agent printed to ask it — is still shown as the screen drew
    it; `readSelectPrompt` now reports where the rows start (`start`) so the
    two can be told apart, and the rows are not printed twice.
  - A tap sends the same arrow keys and Enter the on-screen key row sends
    (`selectKeys`), so a tapped row lands exactly as a walked one. Nothing
    here decides what the options are.
  - The tapped row says "Sending…" and the list is closed to a second tap
    until the session redraws. If the answer never lands (6 s), the list goes
    live again rather than leaving a block that can no longer be answered.
  - **Bounded to the dialog, 2026-09-20.** "Above the rows" was everything
    since the last prompt echo, so a Codex tab that had not been prompted yet
    put its whole startup banner — version, model, directory, the `/fast` tip,
    a config warning — under "On screen now", and a mid-turn question repeated
    the answer the conversation above already shows (measured against the live
    pane: 16 of 21 lines were banner). `readSelectPrompt` now also reports
    `question` (the block directly above the rows) and `context` (that block
    and one more, ≤ 10 lines): the question is the list's own heading, the
    context stays as the screen drew it — in Claude's permission dialog the
    file and the diff — and nothing above it is shown. The block label says
    **"Waiting for your answer"** rather than "On screen now".
  - The heading is drawn in the reading view's type, dedented, with the
    emphasis kept and the palette dropped: Codex paints its question on a
    near-white card, which in this dark view was a white slab. Only the
    heading — the screen around it keeps the colours the session sent.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — open a Claude tab in Focus → Session and ask it
    for an edit it must request permission for: the question shows with
    **1 / 2 / 3** as tappable rows, the row Claude highlights marked. Tap row
    2 → it says "Sending…", the desktop's dialog takes that answer, and the
    list is replaced by the turn. Repeat with a `/model`-style multi-row
    dialog and with Codex's approval prompt. Confirm a numbered list inside an
    agent's ordinary answer is *not* turned into tappable rows.
  - [ ] 🖐️ Manual phone QA — a fresh Codex tab whose first screen is a
    question (the "Luna Reserve / Upgrade / Add Credits" prompt does it): the
    block holds the question and the line that says why it is asked, in the
    reading view's own type — no white card, no startup banner — and the three
    rows below it answer it.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

---

- [~] **31ap — Fold a column away on the phone's to-do board** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). The board
  is one column under another on a phone, so a board of six is mostly scrolling
  past the four that are not today's problem — Done and the archive worst of
  all, since both are read once a week and neither can be removed.
  - Tapping a **column's name** folds it shut and tapping it again opens it
    (`aria-expanded` on the name, a caret beside it). The head stays whole while
    folded — the name, the count, and the four verbs — so a folded column can
    still be renamed, reordered or deleted without opening it.
  - The fold is **this phone's**, like the two hide switches beside it: a
    `localStorage` set of column ids (`prefs.ts` → `readOrder`/`writeOrder`,
    `todoCollapsedColumns`), so it needs no desktop round trip and the desktop
    board is untouched. Ids of columns the board no longer has are dropped as
    the set is written.
  - A folded column with cards behind it says so ("3 cards folded away"), which
    is what keeps a search honest: the head's badge counts every matching card
    and the line counts the ones the fold is holding, so a search whose only
    hits are in a folded column does not read as a search that found nothing.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — fold Done and the archive: both heads keep their
    counts, the cards go, and the fold survives a poll, a trip into another tab
    and an app relaunch. Search for a word that only matches a card in a folded
    column and confirm the column says how many it is holding; open it and the
    card is there. Rename and reorder a folded column from its head. Delete a
    folded column and confirm the fold does not come back on a new column.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31aq — The phone keeps a half-typed message** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). The
  composer's text lived in React state and nowhere else, so every way out of a
  session took it: the back chevron unmounts the terminal screen, and a phone
  puts a PWA away and cold-starts it whenever it likes. A message typed on the
  way to the desk — the long ones are exactly the ones typed away from it — was
  gone by the time the reader came back to finish it.
  - The draft is now kept on the phone (`mobile-web/src/drafts.ts`,
    `tabtivity.mobile.drafts`), **keyed by tab**: two agent tabs each hold their own
    half-finished thought, and a draft never surfaces in the session it was not
    meant for. Opening a tab restores its own text; an empty composer — sent or
    cleared — forgets it, because there is then nothing to come back to.
  - Never crosses the bridge. An unsent message is not something the desktop is
    told about; this sits beside the view preferences (`prefs.ts`) for that
    reason and is read by nothing else.
  - Written 400 ms after the typing stops, and flushed again on unmount and on
    `pagehide` — a store write is synchronous and re-serializes the record, so
    per keystroke would put it between the reader and their next letter, and
    `pagehide` is the last word a phone gives a PWA it is killing.
  - Bounded: the newest 20 tabs' drafts, 20 000 characters each, and anything
    that is not the written shape reads as no draft at all rather than being
    trusted into a composer.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — type half a message into an agent tab, go back to
    the tab list and open the tab again: the text is there, and a second tab's
    composer is empty. Send it and re-open the tab: the composer is empty.
    Type again, switch to another app and let the phone kill the PWA, then
    relaunch: the text is back. Type into a shell tab and confirm the same.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ar — A project's header carries its tab order** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). The
  project screen spent two rows on its own chrome: the back chevron and the
  project's name, and under them a **Sort** row for a picker set about once a
  week. A phone screen holds five tab cards, so that row cost a card.
  - The header is now one line — chevron, name, order — read the way an agent
    tab's header is (`.terminal-title` beside the back button, the control on the
    right, which is where that screen's view switch sits). The name takes the
    room it needs and ellipsizes; the select takes the width its own value needs,
    and under 420 px the word "Sort" goes, the select keeping its label for a
    screen reader.
  - Still only drawn when there are two or more tabs to order, and the order is
    still this phone's own (`projectTabsSort`), unchanged.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — open a project with several tabs: the chevron, the
    project's name and the picker are on one line, the cards start right under
    it, and changing the order still rearranges them and survives a relaunch.
    Open a project whose name is long and confirm the name ellipsizes rather than
    pushing the picker off the screen; on a narrow phone confirm the picker is
    still reachable with one thumb. Open a project with one tab and confirm the
    header carries no picker.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31as — The open mark leaves the ✕'s corner, and a fullscreen agent's
  question reaches the phone** (2026-09-20; ✅ code-complete, automated tests
  passing, ⚠️ not verified on a phone).
  - An agent card's status pill and the `›` that says the card opens the
    session sat in its top-right corner, a few pixels from the ✕ that closes
    the tab — the one tap on that card nobody wants to miss. They now sit on
    the card's foot, right end, beside the schedule line; the opener itself is
    stretched over the whole card (head, prompts and foot), so a tap anywhere
    the ✕, the grip, the colour dot, the name or the ◷ has not claimed still
    opens the session. A shell card is one row and keeps its `›` where it was.
  - Focus showed no question for a Claude tab run with `"tui": "fullscreen"`:
    Claude then draws its whole session on the alternate screen, and Focus
    dropped every live screen read there — the frame is repainted whole and has
    no scrollback, so it was absorbed nowhere and read for nothing. The stored
    session cannot carry a choice the agent has not been given yet, so the
    question reached the phone in no way at all. The frame is now read for the
    live facts only — the question, the working row, the status row and the
    model picker — while the reading view and the history stay on the stored
    session (`docs/mobile_focus_cli_survey.md`).
  - Claude Code's AskUserQuestion draws the highlighted row's **preview** in a
    panel beside the rows. Its frame stood in the rows' second column, so every
    option carried a note of box-drawing characters; a second column that opens
    with a frame edge is now dropped as the panel it is. Ground truth: a real
    215-column capture, replayed through `readableScreen`, now a fixture in
    `src/__tests__/mobile/MobileSelectPrompt.test.ts`.
  - Needs a rebuild of the embedded PWA and a desktop restart to serve it.
  - [ ] 🖐️ Manual phone QA — open a project: on an agent card the pill and `›`
    are at the bottom right, and tapping the card (including that corner) opens
    the session while ✕ still only closes it. Then, in a Claude tab running
    fullscreen, have the agent ask a question: in Focus the question and its
    rows appear under the stored session, the rows carry no box-drawing notes,
    and tapping one answers it. While the turn runs, the "Working" dots show;
    swiping right shows the status line.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31at — Antigravity's model and effort reach the phone** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone).
  - The model chip on an `agy` tab read **"Gemini"**: Antigravity prints its
    model as a phrase with the reasoning effort beside it (`Gemini 3.8 Flash ·
    high`), and `statusLine` matched the family token and dropped the rest. The
    footer's right-hand column is read whole now, `effort` is a status field of
    its own, and the chip prints both.
  - Tapping the chip opened an **empty sheet** that timed out over a dialog
    left open in the session: Antigravity's `Switch Model` list carries no row
    numbers and marks its highlight with the same `>` its input box draws, so
    `selectPrompt` recognized nothing. It is read by its heading and its
    `Search:` field now (`mobile-web/src/terminal/antigravity.ts`), and its
    rows are numbered from the window note (`[1-6 of 7 items]`) — absolute
    positions, so the existing walk-by-number answers it unchanged.
  - **The effort is on that same dialog**, as a slider under the rows
    (`◂ ●━━━◉───○ ▸` over `low medium high`), belonging to whichever model the
    highlight is on, and Enter applies model and effort together. So the sheet
    asks in two steps where the dialog draws one: the tap walks the highlight —
    accepting nothing — the dialog redraws its slider for that model, and the
    stops it then offers are the second step. A model with no slider (every
    Claude model Antigravity offers) is accepted as soon as the walk lands.
  - The dialog is drawn *under* the input box, so the reading view now cuts at
    that box: without it a model row read as the input line and the dialog's
    own rows as the status under it.
  - Ground truth: `agy` 1.2.7 driven through a pty at 80×24 and replayed
    through the phone's emulator; the surviving screens are the fixtures in
    `src/__tests__/mobile/MobileAntigravity.test.ts` and
    `src/__tests__/mobile/MobileAntigravityModel.test.tsx`
    (`docs/mobile_focus_cli_survey.md` holds the shapes).
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — open an `agy` tab on the phone: the model chip
    reads the model *and* its effort (`Gemini 3.8 Flash · high`). Tap it: the
    sheet lists all seven models with the session's own marked. Tap a Gemini
    model — the sheet then asks for the effort, with the stop the dialog is on
    marked; tap another stop and the session's footer changes to it. Repeat
    with a Claude model: it applies at once, with no effort step. Check that
    closing the sheet closes the dialog in the session too.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31au — A chat message is held, and the hold says what to do with it**
  (2026-09-20; ✅ code-complete, automated tests passing, ⚠️ not verified on a
  phone).
  - Copy and read-aloud were two small buttons hanging beside every bubble.
    They are a sheet now (`mobile-web/src/components/MessageMenu.tsx`), opened
    by a click-hold on the message itself — 450 ms, and a finger that wanders
    more than 12 px is scrolling the chat, not holding it. A right-click is
    the same press on a mouse, and the browser's own long-press callout is off
    over a bubble so it cannot fight that press.
  - A prompt offers the same two as an answer: the reader's own words are read
    back. Both readings have it — the stored session (`TranscriptTurns`) and
    the screen (`ReadableTurns`) — and a pending prompt, which is an ordinary
    prompt bubble, comes with it.
  - The message is read at the moment of the press and kept, so the sheet acts
    on what the bubble said; a raw screen row or tool output is no message and
    a hold on one opens nothing.
  - The bubbles gained the width the buttons reserved.
  - Needs a rebuild of the embedded PWA (`npm run build` did it) and a desktop
    restart to serve it.
  - [ ] 🖐️ Manual phone QA — in an agent tab's Focus view, hold a finger on one
    of the agent's answers: the sheet opens with the message's first words,
    **Copy message** and **Read aloud**. Copy says "Copied" and closes itself;
    the clipboard holds that one message. Hold the answer again and tap Read
    aloud — the phone speaks it and the row becomes **Stop reading**, which
    stops it. Do the same on one of your own prompts, on both the Session and
    the Screen reading. Then scroll the chat by dragging from inside a bubble:
    no sheet opens, and no text gets selected.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [ ] **31av — A box tab says which member it runs in** (planned 2026-09-20,
  not built; plan: `docs/mobile_box_parity_plan.md`). A box's tabs run in
  several roots — the box folder and each *local* member's tree — and the
  phone shows no hint of which, so two `claude` tabs in a four-member box are
  indistinguishable unless their labels differ. The desktop never has this
  problem: its `+` menu names the member outright.
  - `PublicTab` gains `member: Option<String>` (the member project's display
    name; absent in the box folder and on every project scope), and the box's
    Home row gains its local-member count. `resolve_scope` already
    canonicalizes `roots` and tests each tab with `canonical_below_any`; the
    only new input is a name per root, so `ScopeSource.roots` carries
    `(PathBuf, Option<String>)` and `ResolvedProject` a parallel label vec —
    `roots` itself keeps its shape so no existing check moves.
  - The phone prints it as a chip beside the tab name, the same treatment the
    model tag got in 99db99c — the working sibling, not a new one.
  - **Decide before merging:** a member project's name currently never reaches
    the phone unless that project has its own Mobile switch on. This publishes
    it on the box's switch alone. Defensible (the switch already discloses
    that member's tabs, labels and transcripts), but it widens what the switch
    means — say so in `docs/context/project_boxes.md`. No path, project id or
    member id leaves the desktop in this item.
  - Tests: the `discovery.rs` box case gains a member-root tab, a box-folder
    tab and the "raw ids never appear" assertion; a PWA render test beside
    `MobileTabModel.test.tsx`.
  - Blocked on 31aa's manual phone QA — that path has never run on a phone,
    and this would put new UI on top of it.
  - Needs a rebuild of the embedded PWA and a desktop restart to serve it.

- [ ] **31aw — Open a tab in a box member's root from the phone** (planned
  2026-09-20, not built; plan: `docs/mobile_box_parity_plan.md`). The phone's
  `create` uses `scope.cwd`, which for a box is always the box folder, so the
  more useful half of a box — start an agent *in that repo* — is unreachable
  from the phone. The desktop offers **Files / Shell / ⟨agent⟩ — ⟨member⟩**
  rows (`NewTabMenu.tsx`, `TabBar.tsx`, via `boxMembersOfScope`).
  - A box row publishes `members: [{ id, name }]` with `id` opaque
    (`key_id(host_key, "member", [scope, member project])`, which adds
    `"member"` to `valid_opaque_control_domain` and its test), and the create
    request gains an optional `member_id`. The sidecar resolves it to the
    member's canonical root the same way it already rewrites `project_id` to
    `raw_id`, checked against that scope's own `roots` so a member id from
    another box cannot cross scopes; the bridge then takes `cwd` from it.
    Unknown, cross-scope, or on a project scope → `invalid_request`.
  - Phone side: a member selector on the create row, box scopes only, box
    folder still the default so the one-tap flow is unchanged. Shell and agent
    only — the phone has no files surface, so the desktop's "Files — ⟨member⟩"
    row has no counterpart here.
  - Supersedes 31av's plain member count (`members.len()`), and wants 31av
    first: that item settles the name-disclosure question with fewer moving
    parts.
  - Tests: `host.rs` — a create naming a member lands in that member's root,
    a member id from another box is refused, one on a project scope is
    refused; `MobileBoxAccess.test.tsx` — the bridge builds the spec with the
    member's cwd under the box's scope key.
  - Needs a rebuild of the embedded PWA and a desktop restart to serve it.

- [~] **31ax — The model chip works on a plain `opencode` tab** (2026-09-20; ✅
  code-complete, automated tests passing, ⚠️ not verified on a phone). 31aj
  read OpenCode's picker off `opencode --mini`, but the `+` menu launches plain
  `opencode` — the full-screen TUI — and that is what every OpenCode tab here
  actually runs. Its picker is the same overlay drawn with different geometry,
  and none of it was read: the sheet listed nothing and timed out after six
  seconds, so the tab's model could not be changed from the phone.
  - Ground truth is a pty capture of 1.18.31 at 60 and 215 columns, replayed
    through the phone's own emulator and run through the real parsers
    (`docs/mobile_focus_cli_survey.md` holds the shapes). The keys were right
    all along — ctrl+p, `model`, Enter opens it in the full TUI too, and ctrl+u
    plus the row's label answers it; only the reading was wrong.
  - `readOpenCodePicker` now reads the overlay **by the title's column** rather
    than by an indent: centred dialogs, provider groups separated by a blank
    row, the `●` that marks the session's current model, the key-hints footer
    that ends the list, and the composer box and status bar the dialog is
    painted over — whose `┃` and whose `ctrl+p commands` land on either side of
    it and are cut by column. Mini gains the same two fixes it needed (a list
    that runs past its first group, and the row it is on).
  - `readableScreen` no longer reads a box-drawing bar deep inside a row as
    that row's left frame. Stripping it took the whole indent with it, which
    pulled the overlaid rows out of column with the rest of the dialog. The
    status strip is dedented instead (`dedentRows`), so a centred fullscreen
    box still reads flush on a phone.
  - [ ] 🖐️ Manual phone QA — on a plain `opencode` tab, tap the model chip:
    the sheet lists the models by provider with the current one marked, a tap
    switches it (the status row says `model <id>`, and the footer under the box
    names the new one), the sheet closes by itself, and its ✕ closes the
    dialog in the session too. Then confirm a `--mini` tab still lists and
    answers its own picker.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - Needs a rebuild of the embedded PWA and a desktop restart to serve it.
  - **Still open for a plain `opencode` tab**: the Reader view. The full TUI
    has no scrollback, so Reader falls back to the stored session
    (`services::opencode_store`), which carries the prompts and the agent's
    *text* answers only — a turn that was all tool calls shows as nothing, and
    an interrupted one as a prompt with no reply. Either the reader learns to
    show OpenCode's tool/patch steps, or the tab is started `--mini`.

- [~] **31ay — The project screen shows what the desktop sent** (2026-09-20; ✅
  code-complete, automated tests passing — the sidecar's project-outbox route
  test and `MobileProjectOutbox.test.tsx`; ⚠️ not verified on a phone, and it
  needs a rebuild + restart first: the sidecar gained two routes and the phone
  serves the bundle baked into the binary). 31x put the agent's files behind
  the gallery button on one tab's Focus screen, which is where they are least
  findable: `tabtivity-send` is run from whichever tab is to hand, and the reader
  who wants the file opened the *project*. A shelf under the tab cards shows
  them where the project is.
  - **Sidecar**: `GET /api/v1/projects/{id}/outbox` and `…/outbox/{name}`,
    the same `outbox.rs` listing and bytes as the tab routes — the outbox
    belongs to the project, so a file sent from a tab that has since been
    closed is still listed, and a project with no agent tab at all still has
    one. Unknown project → `project_not_found`; every refused name is still
    one `file_not_found`.
  - **Phone**: the project screen polls the listing every 8 s while the page
    is visible (`OUTBOX_POLL`, the Focus screen's own cadence) and draws a
    **From the desktop** shelf under the cards when there is something on it —
    the gallery's own tiles (`OutboxGrid`), newest six, a picture full screen,
    a PDF in the browser's viewer, anything else saved. Past six, **All N
    files** opens the same gallery sheet the Focus button does.
  - [ ] 🖐️ Manual phone QA — run `tabtivity-send <file>` in a project tab (a PNG,
    a PDF and a `.zip`), open that project on the phone: within ~8 s the shelf
    stands under the tab cards with the newest first; tap the picture → full
    screen, Close returns; the PDF opens in the browser; the zip saves. Send
    seven more → the shelf still shows six and **All 10 files** opens the
    sheet with all of them. Close the tab the files were sent from → the shelf
    is unchanged. With Tabtivity closed → the shelf still lists what is there.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31az — The root console on the phone** (2026-09-21; ✅ code-complete,
  automated tests passing — `discovery`'s
  `the_root_scope_is_listed_by_its_switch_and_gate_alone`,
  `MobileRootAccess.test.tsx`, `scopeCaption` in `MobileProjectOrder.test.tsx`;
  ⚠️ not verified on a phone, and it needs a rebuild + restart first: the
  sidecar's catalog changed and the phone serves the bundle baked into the
  binary). Rationale:
  `docs/context/root_console.md` ("On the phone"). Root is a phone scope behind
  its own default-off switch (Settings → Tabtivity Mobile → Root console) and a
  gate: with the root MCP tools on it is listed only while write review is
  "all" and root agents are fenced. Approvals stay on the desktop; the phone's
  root row shows the count of waiting proposals.
  - [ ] 🖐️ Manual phone QA — switch "Root console on the phone" on: a **Root**
    row (`★ root`) appears on the phone with the console's shell/agent tabs;
    open a running root agent and type into it; ＋ → an agent: the root console
    rises on the desktop over the open project (no scope switch) with the new
    tab in front; ask it for a calendar entry → nothing is written, the
    desktop's ✓ Approvals shows it, and the phone row reads "1 awaiting
    approval at the desk". Set MCP write review to "Destructive only" → Settings
    shows the "Closed right now" line, the row leaves the phone within a few
    seconds and an open root terminal detaches; back to "All writes" → it
    returns. Switch the root MCP tools off with review still weakened → the
    row is listed. Switch root access off → gone.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ba — The gallery's pictures, cropped and stepped through** (2026-09-23;
  ✅ code-complete, automated tests passing —
  `MobileFocusOutboxGallery.test.tsx`; ⚠️ not verified on a phone, and the
  phone serves the PWA baked into the binary, so it needs a rebuild + restart).
  - **Thumbnails**: the tile styles went with the old strip in 31am, so a
    gallery picture drew as a bare browser button around a stretched image.
    A picture tile is again the picture alone, cropped to 4:3 with a border,
    name and age under it — on the Focus gallery and the project shelf alike.
  - **Stepping**: a picture opened full screen (`OutboxViewer`) steps through
    the gallery's other pictures in place — ‹ › on the picture's edges, a
    sideways swipe (a pinch or a mostly vertical drag is left alone), or the
    arrow keys; the head reads `2 / 5 · 48 KB`. PDFs, texts and downloads are
    skipped: they open their own way. The neighbours are fetched ahead so a
    step does not land on a blank. Sizes read `1.4 MB` rather than `1434 KB`.
  - [ ] 🖐️ Manual phone QA — `tabtivity-send` three PNGs and a PDF from one tab,
    open the gallery: the three pictures are cropped tiles of one shape, none
    squashed. Tap the newest → `1 / 3`, no ‹; tap › → `2 / 3`; swipe left →
    `3 / 3`, no ›; swipe right → back; drag down instead → nothing moves;
    pinch → zooms, no step. ✕ lands on the grid. From the project screen's
    shelf the same.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bb — The project screen's ＋ sends a document from the phone**
  (2026-09-23; ✅ code-complete, automated tests passing —
  `MobileNewTabSheet.test.tsx`, host test
  `a_file_sent_from_the_project_screen_lands_in_that_projects_inbox`; ⚠️ not
  verified on a phone — needs a rebuild + restart, the PWA is baked in).
  - The ＋ sheet ends in **Send a file from this phone** (native picker, any
    type, several at once). Each file goes raw to the new
    `POST /api/v1/projects/{id}/inbox` — the same `.tabtivity/inbox/` drop box
    and limits as the Focus composer's + (31n), named by the project because
    that screen has no tab. A row per pick under the header says
    *In the project as @.tabtivity/inbox/<stamp>-<name>* with **Copy** (puts the
    `@reference ` on the clipboard for an agent's prompt) and ✕.
  - [ ] 🖐️ Manual phone QA — open a project, ＋ → Send a file from this
    phone, pick a PDF and a photo: the sheet closes, two rows say *Sending…*
    then *In the project as @.tabtivity/inbox/…*. Copy → paste into an agent
    tab's composer → the agent reads the file. Also from a project with every
    tab closed. A >24 MB pick fails at once with *is larger than 24 MB.*
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bc — Subagents in the Reader, opened and stepped through**
  (2026-09-24; ✅ code-complete, automated tests passing —
  `MobileTerminalSubagents.test.tsx`, `agent_transcript`/`opencode_store`
  subagent tests, and a read of a real Claude session with two subagents;
  ⚠️ not verified on a phone — needs `npm run package:dev` + relaunch, the
  PWA and the backend are baked in. Pill: `mobile.focus.subagents`).
  - Each subagent the agent spawned is a card in its place in the stored
    session: kind (`Explore`, a Codex role · nickname, an OpenCode agent)
    over its task. Tapping it opens that subagent's own conversation — its
    task as the first prompt, its messages as bubbles, its own subagents as
    cards — under a sticky bar: ‹ back up (to where that conversation was
    scrolled), the task, and `‹ 1 of 3 ›` through the subagents beside it.
    Sending a prompt from there goes back to the session.
  - Per CLI: Claude `<session>/subagents/agent-<id>.jsonl` matched to its
    `Agent` call by the `.meta.json` beside it; Codex `thread_spawn_edges`
    in its state store (⚠️ no Codex subagent run exists on this machine —
    shape read from the 0.156.1 binary, not a real run); OpenCode child
    sessions by `parent_id`. The phone only ever holds a digest of the id,
    looked up among the tab session's own subagents.
  - [ ] 🖐️ Manual phone QA — in a Claude tab ask for two parallel Explore
    agents. In the Reader two cards appear under the answer that spawned
    them; tap the first → its task, then its messages; `1 of 2`, › → the
    second; ‹ back → the session, scrolled where it was. While a subagent
    is still working its conversation grows in place. Send a prompt from
    inside a subagent → back in the session with the bubble. Repeat in a
    Codex tab with multi-agent on, and an OpenCode tab (`@explore …`).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bi — Mobile ↔ desktop link hardening** (2026-09-24; ✅ code-complete,
  automated tests passing — `auth.rs`, `pty_bridge.rs`, `limits.rs`,
  `protocol.rs`, the mobile vitest suite; ⚠️ never run on a phone; the sidecar
  and the bridge both changed, so a rebuild + restart first). The nine steps: input frames acked by the sidecar and a
  lost prompt marked on its own bubble with Resend (1); sliding 15-min session
  renewed silently on a 401 while the reader is active, PIN on every cold open,
  `session_expired` told apart from `access_revoked` (2); the service worker
  serves the cached shell on a proxy 502 (3); one failure vocabulary
  (`connection.ts` `describeFailure`), usage errors as codes, the reconnect line
  once per outage (4); the Reader stays for a tab with no session id yet (5);
  `subscribed` replaces the calendar feed URL on the wire, calendar edits in a
  sheet and deletes in the option sheet (6); a 5-minute idle deadline on every
  sidecar socket, the history replay in ≤64 KB frames, a flooding pane sheds its
  oldest output instead of closing the link (7); the Home list reloads on
  show/online and on a slow retry (8); per-domain bridge mutation queues (9);
  tmux `prefix None` on Tabtivity sessions (decision 5). Not done from the plan:
  the optional `calendar_writes`/`todo_writes` desktop switches (6, "consider")
  — a CalDAV delete from the phone is still guarded by the confirm sheet alone.
  - [ ] 🖐️ Manual phone QA — slow answers are waited for, and a wedged tmux costs no terminal (2026-10-01; `api.ts` `TAB_CREATE_TIMEOUT` / `MAIL_MESSAGE_TIMEOUT` / `SIGN_IN_CALLBACK_TIMEOUT`, `discovery.rs` `TMUX_LS_TIMEOUT` + carried-forward live map, `pty_bridge.rs` `catalog_unavailable`; ⚠️ never run on a phone; sidecar + PWA rebuild first): (a) open a large mail message for the first time on a slow IMAP account, and ＋ a new agent tab while the desktop is busy → each lands, or fails with its own reason — never "Your desktop didn't answer" followed by the thing having happened anyway. (b) With a terminal open on the phone, `kill -STOP "$(tmux display-message -p '#{pid}')"` for ~20 s, then `kill -CONT` the same pid: the phone's project list keeps its tabs as they were, the open terminal is not closed with "access was withdrawn", and everything resumes. Switching the project's phone access off during the stop still closes the terminal within ~5 s.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — a dead terminal link lets go at once, and a final close looks closed (2026-10-01; `Terminal.tsx` `abandon` / `dropLink` / `reconnectLater`; ⚠️ never run on a phone; PWA rebuild first): (a) with a terminal open, make the link silent without closing it (switch Tailscale off on the phone, or change networks) → within about a minute the composer disables and shows "Reconnecting…", and the session reconnects once the path is back. Lock the phone during such an outage, unlock: within ~5 s the link reconnects rather than the screen staying "connected" with typing going nowhere. (b) Open the same tab from a second phone or browser → the first shows "This session was opened on another device or tab.", its composer is disabled, a prompt still waiting for its ack reads "Not delivered", and it does not reconnect. Known leftover: the disabled composer's placeholder still reads "Reconnecting…" under that sentence.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — a closed desktop is named quickly, and a sidecar restart mid sign-in is ridden out (2026-10-01; `auth.ts` `PROXY_DOWN_RETRIES` / `STALE_CHALLENGE_RETRIES`, `start_desktop_bridge` bind retry + log; ⚠️ never run on a phone; PWA + backend rebuild first): (a) quit desktop Eldrun, then open or unlock Eldrun Mobile → "Eldrun Mobile isn't running on your desktop" after about 3 s, not about 10. (b) Hard to provoke: switch Mobile off and on in Settings while the phone is unlocking on a slow link → the sign-in still lands, no "Your desktop reported an error"; the connect trace on the slow splash shows `session 401 invalid_challenge` followed by a second challenge. (c) With `mobile-control/` made read-only before launch, Eldrun's stderr says `mobile host: desktop bridge cannot listen on …` after about 5 s (Windows: the block only needs to compile — never compile-checked).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — large desktop answers arrive, and a slow upload is not cut (2026-10-01; `protocol.rs` `MAX_DESKTOP_RESPONSE`, `admin.rs` `write_desktop_response`, `limits.rs` `BODY_TIMEOUT`; ⚠️ never run on a phone; backend rebuild + sidecar update first): (a) with the desktop open, open an agent tab with a long session in Focus → the chat loads; open a large To-do board and a busy Calendar month → no "read-only" notice, and adding a card answers with the board rather than "Eldrun isn't running on your desktop" (no duplicate card). (b) On mobile data, ＋ → From this phone → a photo of 10 MB or more → it arrives instead of failing after about 15 s with "Eldrun Mobile isn't running on your desktop".
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — "every second unlock fails, Retry works" (2026-09-27, `mobile.link.unlockRetry`): leave the PWA past the 3-minute lock with the screen off for a few minutes, come back, unlock ten times in a row: each one connects (Connecting… may run ~10 s on a dead connection, then lands) and none shows the failure splash; when a splash does show, Retry connects without asking for the fingerprint again. Phone-bundle-only change: commit, let the dev build publish, pull to refresh.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — the lock sheet over Home (2026-09-27, `mobile.lock.homeSheet`): lock the phone (idle timeout or backgrounding past it), then reopen — the PIN/fingerprint form rises as a sheet over Home's own header and build line, not its own full screen; unlock still lands on the project list as before. Phone-bundle-only change: commit, let the dev build publish, pull to refresh.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — plan-mode tint on the Mode fact (2026-09-27, `mobile.focus.planModeMark`): in an open agent session, switch the CLI's own permission mode to plan (Shift+Tab or its picker) — the Mode button in the facts row fills purple while plan mode holds, and returns to plain once switched away. Phone-bundle-only change: commit, let the dev build publish, pull to refresh.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — open the PWA with the desktop closed: the app's own "Tabtivity Mobile isn't running on your desktop" splash, never the proxy's 502 page (step 3).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — type a prompt, drop the phone to airplane mode within a second, wait a minute, reconnect: the bubble stays where it was, says "Not delivered", and Resend delivers it exactly once (step 1).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — `systemctl --user restart` the mobile host while reading a tab: no PIN screen, the terminal reconnects on its own; then leave the phone untouched past the 3-minute idle lock and come back: the PIN screen (step 2).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — kill the PWA from the app switcher and reopen: the PIN or fingerprint every time, and the reader lands back on the tab they had open (step 2).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — create an agent tab from the phone: it opens in the Reader, reads the screen until the agent's hook records a session, then paints the stored session without a tap (step 5).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — quit the desktop with the sidecar up, then open a project: prose ("Tabtivity isn't running on your desktop."), never `Error: desktop_unavailable`; the status sheet's usage error reads as a sentence too (step 4).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — Calendar → Calendars → Edit opens a sheet with name and colour; Delete asks in the option sheet; a subscribed feed still says Subscribed (step 6).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — on the Projects tab, kill the sidecar, wait for the red notice, start it again: the list comes back on its own within half a minute, or at once when the app is brought back to the front (step 8).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual phone QA — with a phone on cellular, run `yes` in a shell tab for ten seconds: the terminal keeps up or skips ahead, but never disconnects and replays the whole flood (step 7).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bj — The agent's pictures are chat messages again, WhatsApp-style** (2026-09-25;
  ✅ code-complete, automated tests passing — `MobileOutboxPosts.test.ts`,
  `MobileFocusOutboxGallery.test.tsx`; ⚠️ not verified on a phone). Reverses
  31am's "never in the chat" at the user's request, but not back to 31bd's
  file cards: what `tabtivity-send` puts out shows in the Focus chat (stored
  session) as a picture bubble — thin rim, no filename, the time over its
  corner — and one send of several files is one album bubble (2 side by
  side, 3 as one wide over two, 4+ as a 2×2 whose last tile reads "+N").
  Non-picture files are slim cards in the same bubble. The 🖼 gallery stays.
  - Placement (`mobile-web/src/terminal/outboxPosts.ts`): after the last
    record written at or before the file's mtime; files ≤ 10 s apart with no
    record between them are one post. Files older than the first shown record
    (earlier sessions, truncated turns) stay gallery-only; the screen chat has
    no times, so it shows none. The outbox is per project, so another tab of
    the same project sending during this conversation also shows here.
  - Needs the embedded PWA rebuilt (`npm run mobile:bundle`) and a desktop
    restart to be served. Untested id `mobile.outbox.chat`.
  - [ ] 🖐️ Manual phone QA — in a Claude tab ask "send me a screenshot to my
    phone": within ~8 s a picture bubble appears after the agent's message
    that preceded the send, in the picture's own shape, time in the corner;
    tap → full screen. Then "send me three plots at once" → one album bubble
    with three tiles. The 🖼 count still rises and the gallery lists them all.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **31bk — Agent sign-in (`/login`) from the phone, every CLI** (2026-09-27;
  ✅ code-complete, automated tests passing — `MobileSignIn.test.tsx`,
  `mobile_control::sign_in` + host route test; ⚠️ not verified on a phone).
  A CLI printing a sign-in link (OAuth/device markers only, bottom 40 lines)
  gets a notice over the composer → **Sign in** sheet: *Open the sign-in
  page* (a real link, so the phone's browser takes it) + Copy link, then by
  flow — device code shown with Copy (Copilot, Qwen); a field for the code
  the page ends on, typed into the session + Enter (Claude, Gemini,
  Antigravity); a field for the `http://localhost:<port>/…` address the
  phone's browser failed on, which the sidecar relays to the CLI's loopback
  listener (`POST /api/v1/tabs/{id}/sign-in-callback`; Codex's ChatGPT
  sign-in) — or nothing (Cursor polls). The Status sheet gains **Sign in**
  for CLIs whose command is documented (Claude/Copilot `/login`,
  Gemini/Qwen `/auth`); the `/` menu lists `/login`, `/logout`, `/auth`.
  - Needs the PWA rebuilt and the backend restarted (the relay route is
    sidecar code). Untested id `mobile.signIn`.
  - Open: whether Gemini in the fence prints the paste-code flow or the
    localhost one (no DISPLAY socket in the fence; either is handled);
    Droid/Grok/Vibe sign-in shapes unverified.
  - [ ] 🖐️ Manual phone QA — Claude tab → Status → Sign in → pick the
    subscription row in the chat → notice → Sign in → open page, approve,
    copy the code, paste → Send → Claude says Login successful and the
    notice goes. Then a Codex tab signed out → "Sign in with ChatGPT" →
    open page, approve → copy the failed localhost address → Finish
    sign-in → Codex continues.
    - 2026-10-01: Claude sign-in from the phone confirmed working by the
      user (`mobile.signIn`, `mobile.signIn.tab` stamped tested); the
      Codex half is still open, so the boxes stay unticked.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - **Rework 2026-09-28 — phone-only sign-in tabs** (✅ code-complete,
    automated tests passing — `MobileSignInTab.test.tsx`,
    `MobileSignInCreate.test.tsx`, `SignInLaunch.test.ts`,
    `MobileLaunchOptions.test.tsx`, `mobile_control` host/protocol tests;
    ⚠️ not verified on a phone). No TUI menu to find any more: a **sign-in
    tab** runs the CLI's own login command in the flow a phone can finish
    (`src/lib/agents/signInLaunch.ts`: Claude `auth login --claudeai`, or
    `--console` as the other way in; Codex `login --device-auth`, or `login`
    through the browser; Copilot `login --device-code`; Cursor `login`;
    OpenCode `auth login`; Amp `login`; Gemini `NO_BROWSER`; the rest a plain
    launch). Reached from Project ＋ → **Sign in to an agent** (each CLI's
    shared-login state from `agent_auth`, Sign in / Sign in again / the other
    way in), from an agent tab's new **"… needs you to sign in"** notice
    (`readSignedOut`: Not logged in, Please run /login, Invalid API key, a
    login-method screen), and from Status → Sign in. The sheet is now
    numbered steps: one tap copies a device code and opens the page, a
    **Paste the code / address** button reads the clipboard and sends it,
    **Signed in ✓** with Done (which closes a login-command tab), and **Start
    again** or the other way in when the login ended without success. New
    routes: `POST /api/v1/tabs/{id}/sign-in`; `sign_in` on the create
    request (`like_tab` sidecar-only); `sign_in` rows in launch-options.
    Untested id `mobile.signIn.tab`. Needs the backend restarted (sidecar
    routes + protocol fields); the PWA is rebuilt.
    - **Fix 2026-09-30 — the phone never reached the sign-in tab** (✅ code-complete,
      automated tests passing — `TabPersistFilter.test.ts`,
      `discovery::sign_in_and_cloud_tabs_are_listed_without_a_session`; ⚠️ not verified on a
      phone). A sign-in tab has no session id, so it was neither tmux-wrapped nor
      saved to `terminals.json`, and the sidecar's catalog lists only resumable
      agent tabs: the create waited 5 s and answered `launch_pending`. Sign-in
      tabs now carry `signIn`: tmux-wrapped and saved while they run
      (`isSavedWhileLive`), listed by the catalog, dropped on the next load.
      Needs the backend restarted (catalog field). Captured 2026-09-30, Claude
      2.1.284 `auth login --claudeai` prints `If the browser didn't open, visit:
      https://claude.com/cai/oauth/authorize?code=true…` then `Paste code here if
      prompted >` (flow `code`). Phone-launched cloud tabs had the same gap
      (confirmed from code: `buildCloudTabSpec` mints no session id) and now
      carry `cloud` the same way (`CloudSessions.test.ts`, `discovery::
      sign_in_and_cloud_tabs_are_listed_without_a_session`); a desktop cloud tab
      in a Mobile-access project is now listed on the phone too.
    - **Fix 2026-09-30 — the phone forgot a tab was a sign-in tab** (✅
      code-complete, `MobileSignInTabRow.test.tsx`; ⚠️ not verified on a phone).
      The catalog row now carries `sign_in` (a boolean, nothing else), so a
      sign-in tab opened from the tab list or after a PWA reload keeps its sheet
      with Start again / the other way in / Done-closes-the-tab. PWA rebuilt;
      needs the backend restarted.
    - Unverified CLI shapes: Codex `--device-auth` (the ChatGPT account may
      need device-code sign-in allowed first — then use "Sign in through the
      browser instead"), Cursor/OpenCode/Amp login output, what Claude's
      `auth login` prints in the fence (expected: the manual URL + "Paste
      code here if prompted").
    - Switching accounts still needs Sign out on the desktop first (the
      account guard refuses a different account's login).
    - [ ] 🖐️ Manual phone QA — Project ＋ → Sign in to an agent: rows show
      each CLI signed in / not. Claude → Sign in → the sheet waits, then
      shows the page → open, approve, copy the code → back → Paste the code
      → "Signed in to Claude ✓" → Done closes the tab and the row reads
      Signed in. Copilot → Sign in → "Copy the code and open the page" →
      paste on GitHub, approve → Signed in ✓. Codex → Sign in (device) or
      "Sign in through the browser instead" → Finish. Then a Claude tab
      that says "Not logged in" → notice → Sign in opens the sign-in tab.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
- [~] **31bl — Local-model agent tabs on the phone** (2026-09-28;
  ✅ code-complete, automated tests passing — `MobileLocalAgents.test.tsx`,
  `TabPersistFilter.test.ts`, `TmuxSessions.test.ts`, `ollama` /
  `terminal_service` / `mobile_control` discovery + protocol tests;
  ⚠️ not verified on a phone). Project ＋ gains the desktop "+"'s
  **Local model · <model>** group (the `ollama_roles.tabs` model): Mistral
  when installed, then every available driver (Claude Code, Codex, OpenCode,
  Droid, OpenClaw), with the heavy-harness caution as a note. A model not on
  the GPU still offers them; the start loads it (`load_ollama_model` gpu) and
  the sheet says the first answer waits. Local-model tabs are listed on the
  phone as agent tabs (named for the driver's CLI) and reattach like any
  agent. For that, in a Mobile-access project/box: local tabs are tmux-wrapped
  (`agent` token), and the `ollama launch` tabs record their launch line
  (`TabEntry.localLaunch`) and so **restore after a desktop restart** — as a
  fresh conversation after a clean quit (which reaps Tabtivity's tmux
  sessions); after a crash the tmux session still holds the agent. The
  backend re-validates the line against its driver table on every load
  (`ollama::local_launch_line_ok`); a folder copy never brings one back.
  Tabs started before this, or outside a Mobile project, behave as before.
  Untested id `mobile.newTab.local`. Needs the backend restarted (catalog,
  protocol and sanitizer are Rust); the PWA is rebuilt.
  - Not on Windows: local tabs there are never tmux-wrapped, so the phone
    cannot attach (same as every local agent tab).
  - [ ] 🖐️ Manual phone QA — set a "tabs" local model; in a Mobile project
    Project ＋ → Local model group lists Mistral + the installed drivers →
    Claude Code → the tab opens on the phone and answers; it shows on the
    desktop as "<model> · Claude Code". Quit and restart desktop Tabtivity →
    the tab is back (a fresh conversation) and the phone lists it again;
    a Mistral tab comes back resumed. With
    the model unloaded, the group says it isn't on the GPU and a start loads
    it.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bm — Calendar reminders as push notifications on the phone** (2026-09-28;
  ✅ code-complete, automated tests passing — `push.rs` (RFC 8291 worked
  example byte for byte, VAPID JWT verifies, host allowlist, revoke/forget-all
  coupling), host route test, `CalendarAlarmPush.test.ts`,
  `MobileCalendarReminders.test.tsx`; ⚠️ never sent through a real push
  service or shown on a phone). Calendar → **Reminders** sheet on the phone:
  Off / On, with event details / On, without details. The desktop's reminder
  engine sends each fresh reminder (not snooze wake-ups, not muted calendars)
  through admin `notify`; the sidecar encrypts per phone and POSTs to the
  vendor push service; `sw.js` shows it and a tap opens Calendar. First use of
  the Web Push channel from `docs/tabtivity_mobile_future_plan.md` §A — agent
  `question`/`done` edges can ride it next.
  - Needs the sidecar updated (Settings → Mobile offers it after a rebuild)
    and the PWA rebuilt (`npm run mobile:bundle`). Untested id
    `mobile.calendar.push`.
  - Open: whether Apple accepts the VAPID `sub` (the project's GitHub URL);
    whether iOS delivers while the Home Screen app is fully closed.
  - [ ] 🖐️ Manual phone QA — phone Calendar → Reminders → On, with event
    details → allow notifications. On the desktop make an event 16 min out
    with a 15-minute reminder; close Tabtivity Mobile on the phone; within a
    minute of the reminder the phone shows title · time · place. Tap → app
    unlocks onto Calendar. Switch to "without details" → next reminder says
    only "Calendar reminder". Revoke the phone on the desktop → no more.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

  - [ ] 🖐️ Manual phone QA — a lapsed subscription comes back by itself (2026-10-01; `push.rs` lapsed records, `refreshPush`; ⚠️ never run on a phone; sidecar + PWA rebuild first): with Reminders on, drop the browser's subscription behind Eldrun's back — in the phone's site settings for Eldrun Mobile switch Notifications off and on again (permission is granted again, the subscription is gone) — then trigger one reminder: nothing arrives, and `mobile-control/push.json` shows the row with `"lapsed": true` and empty keys. Reopen Eldrun Mobile and sign in — no prompt — and the next reminder arrives with the same details choice as before. Reminders → Off still removes the row whole.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bn — Agent questions and finished turns as push notifications** (2026-09-28;
  ✅ code-complete, automated tests passing — `push.rs` (per-phone choices,
  decrypted payloads carry only opaque ids when details are off, per-tab
  cooldown), admin `agent_turn` test (unknown / phone-attached tab send
  nothing), `MobileAgentTurnEdges.test.ts`, `MobileCalendarReminders.test.tsx`;
  ⚠️ never shown on a phone). Rides 31bm's channel. The desktop bridge diffs
  each phone-reachable agent tab's state (the one the phone's lists show) and
  reports *into question* and *working → done*; the sidecar resolves the tab
  through its catalog, skips it while a phone holds its terminal, and sends at
  most one notice per tab per 30 s. The Reminders sheet became **This phone →
  Notifications** (also Calendar → Reminders): Calendar on/off · Agents off /
  questions / also finished turns · names and details or not. A tap opens the
  agent's tab (after the unlock when locked). Untested id `mobile.push.title`.
  - Needs the sidecar updated and the PWA rebuilt, like 31bm.
  - Known: a finished turn on the tab in view on the desktop still notifies
    (the desktop cannot tell whether anyone is at it); a notice without
    details is English only (the service worker has no i18n).
  - [ ] 🖐️ Manual phone QA — ⚙ This device → Notifications → Agents → When one
    needs your answer. Leave the phone locked; in a phone-reachable project
    have Claude ask a permission question → notification "Aurora · Claude —
    Needs your answer" within seconds; tap → unlock → that tab. With the tab
    open on the phone, the next question does not notify. Switch to "Also when
    one finishes a turn" → a finished turn notifies. Revoke → nothing.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

  - [ ] 🖐️ Manual phone QA — a pocketed phone still gets the notice (2026-10-01; `TerminalControl::Visibility` / `TerminalEvent::Features`, `TerminalRegistry::is_watched`; ⚠️ never run on a phone; sidecar + PWA rebuild first): Agents → "Also when one finishes a turn". Open an agent tab on the phone, send a prompt, switch to another app (or lock the screen) before the turn ends → the "Finished …" notice arrives, and the tab's row still reads unread/done on the desktop until the phone is looked at again. Back in the tab, with the page in front: the next finished turn does not notify. Coming back from the other app must not replay the history (the socket was kept).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bo — Read-only project files on the phone** (2026-09-28;
  ✅ code-complete, automated tests passing — `files.rs` (sealed tokens bound
  to the project, no link anywhere on the path, hidden names, 500-entry cap,
  24 MiB head for text), host test `the_file_browser_is_off_by_default_and_…`,
  `MobileProjectFiles.test.tsx`; ⚠️ never run on a phone). Plan §D of
  `docs/tabtivity_mobile_future_plan.md`, re-evaluated: one host-wide switch
  **Settings → Mobile → Project access → Project files on the phone** (default
  off) instead of a per-project flag; files open in the outbox's viewer.
  Untested ids `mobile.projectFiles`, `mobile.files.browse`.
  - Needs the sidecar updated and the PWA rebuilt (`npm run backend:stale`).
  - [ ] 🖐️ Manual phone QA — switch it on; on a Mobile project's screen a
    left→right swipe slides the files drawer in from the left (no 📁 in the
    header any more, 2026-09-28); a swipe starting right at the left edge
    opens it too (unless Android's back gesture takes it). Inside an agent tab's
    Focus view (2026-09-29) a swipe from the left third opens the drawer, one
    from further right the status line; in a shell tab any swipe opens it;
    Terminal view opens neither. A right→left swipe over it or a tap beside it
    closes it, and a sideways drag on a card's ⠿ grip does not open it.
    Walk into `src/` and back by the trail; open a `.md` (text
    preview), a `.png` (full screen, pinch, step to the folder's next picture,
    Save, Share), a PDF (browser tab, reading it — it said
    `authentication_required` before its open ticket, 2026-09-29). `.git`, `.env` and a symlink are not
    listed. Switch it off on the desktop → within ~5 s the swipe does nothing and
    an open drawer is gone; a folder opened meanwhile says it was switched off.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Sections + row look (2026-10-04, untested id `mobile.files.sections`;
    needs the rebuilt backend — `ignored` comes from the sidecar's
    `git check-ignore`). At the project root README/AGENTS.md/.gitignore sit
    in a collapsed `scaffold (n)` row below the rest; in any folder of a git
    project, ignored entries (`target/`, `node_modules/`, `*.log`) sit in a
    collapsed `gitignored (n)` row, dimmed when opened; a tracked file matching
    an ignore pattern stays in the main list; a README below the root is an
    ordinary row. Each row has a tinted tile (folder blue, picture green, PDF
    red, text grey) and short times (clock today, day this year).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Search by name (2026-10-04, untested id `mobile.files.search`;
    needs the rebuilt backend — new sidecar route `files/search`, host test
    `the_file_search_answers_sealed_rows_…`, `files.rs` `a_search_…` tests).
    Type part of a name in the box under the drawer's head: matching files
    and folders from anywhere in the project list with their folder above
    the times (`Project folder` at the root); several words must all be in
    the name; nothing git ignores (`target/`, `node_modules/`) and no `.env`
    shows. Tap a file → it opens; close it → the results are still there, and
    clearing the box shows the drawer standing in that file's folder. Tap a
    folder → the drawer walks into it and the box empties. Escape (keyboard)
    clears the box before it closes the drawer. A big project answers in
    about a second.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bp — The phone's host updates itself at launch** (2026-09-28;
  ✅ code-complete, unit test `a_launch_updates_a_host_that_is_behind_…`;
  ⚠️ never seen live). `start_host_on_launch` reinstalls the sidecar copy
  (`mobile_host_apply`) when this version has no copy, the copy is an earlier
  build, or the answering host reports another version; on failure it starts
  the old copy as before. Why: 31bo's project files stayed invisible behind an old copy
  until Update host was clicked. A debug window copies its ~700 MB image on
  each launch that is behind.
  - [ ] 🖐️ Manual QA — with Mobile on, relaunch Tabtivity after a new build →
    `journalctl --user -u tabtivity-mobile-host` shows a restart right after the
    launch, Settings → Mobile no longer offers Update host, and a new route
    (e.g. 31bo's project files) works without clicking anything. Relaunch again with no new
    build → no restart.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bq — Edit a phone prompt until the agent takes it in** (2026-09-29;
  ✅ code-complete, automated tests passing — `MobileHeldPromptEdit.test.tsx`,
  bridge case in `MobilePhoneDrivenStatus.test.tsx`, protocol
  `held_prompts_carry_the_tab_pair_…`; ⚠️ never seen live). A prompt sent from
  the Focus composer while the agent works (its screen's busy row, or the
  desktop's `working`) no longer goes into the CLI's own queue: the desktop
  holds it as a send-now rule (`POST /tabs/{id}/held` → `queuePromptForTab`) and
  types it at the tab's next safe idle point. Until the session records it, the
  bubble's hold menu offers **Edit**: the words go into the composer (the
  draft steps aside), Save rewrites the rule (`PUT /tabs/{id}/held/{id}`,
  guarded by `expectExistingOn` — refused once claimed or delivered), and the
  bubble takes the new words in its place. Trade-off chosen by the user: no
  mid-turn pickup — the prompt arrives when the turn ends. A desktop that cannot
  hold it (no window, older build) → the phone types it as before. Untested id
  `mobile.chat.editHeld`.
  - Needs the sidecar updated and the PWA rebuilt (`npm run backend:stale`).
  - [ ] 🖐️ Manual phone QA — give a Claude tab a long task from the phone;
    while it works send "also the tests" → the bubble shows at once, the note
    under the composer says it waits on the desktop, and the desktop's tab does
    NOT show it queued in Claude's input. Hold the bubble → Edit → change the
    words → Save the edit → the bubble shows the new words in the same place.
    When the turn ends the agent gets the NEW words (once), and the bubble's
    menu no longer offers Edit. Try Edit right as the turn ends → "already
    took this prompt", your words stay in the composer. Send while the agent
    is idle → typed at once as before (no Edit). Repeat once with Codex.
    Leave the tab (back to the project) while the prompt still waits, open it
    again → the bubble is still there, below the working row, and still
    offers Edit (fix 2026-09-30: the phone keeps held prompts per tab in
    `heldPrompts.ts` and re-checks them against the tab's schedules).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31br — Moving status glyphs and an Interrupted state on the phone** (2026-09-30;
  ✅ code-complete, automated tests passing — `MobileAgentTurnEdges.test.ts`;
  ⚠️ never seen live). The project screen's card discs and the Agents list's
  pills show motion: the card keeps ▶ still while a small arc rotates around
  its disc, and the Agents pill pulses gently; ? tips now and then, ✓ and ■
  land once when they appear. Reduced motion turns it all off. New fourth
  state `interrupted` (■, red): the desktop bridge reports the desktop's own
  `interrupted` lamp (`mobileAgentState`), held until the agent's next turn —
  no push notice for it. Untested id
  `mobile.tabs.statusMotion`.
  - Needs the PWA rebuilt (`npm run mobile:bundle`); the sidecar only passes the
    string through, so the desktop's hot reload + a rebuilt PWA are enough.
  - [ ] 🖐️ Manual phone QA — give an agent tab a long task: its card's ▶ stays
    still while a small arc rotates without reaching neighbouring cards, and
    its Agents-list glyph pulses gently. Leave it at a permission prompt: ?
    wobbles every few seconds. Let a turn finish: ✓ pops in once, then holds
    still. Start a turn and press Esc on the desktop (or the phone's Esc key):
    the card shows a red ■ that stamps in once, the Agents list pill reads
    "Interrupted", the status
    sheet says "Interrupted"; no push notice arrives. Send a new prompt → back
    to ▶. With the phone's reduce-motion setting on, nothing moves.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bt — Mark up a PDF or picture on the phone for the agent** (2026-10-01;
  ✅ code-complete, automated tests passing — `markup.rs`/`markup_pdf.rs` units,
  host tests `a_markup_submit_bakes_a_copy_…` and `only_the_pdf_frame_may_be_framed_…`,
  `MobileMarkup.test.ts`, `MobileMarkupView.test.tsx`; ⚠️ never run on a phone
  or an iPad). Plan `docs/mobile_pdf_markup_plan.md`; its §4.0 spike (the
  sealed frame and the Pencil on the iPad) was not run first — the checks
  below are that spike. The bake is Tabtivity's own incremental-update writer,
  not `lopdf` (no crate could be fetched in the fenced tab). Untested ids
  `mobile.markup`, `mobile.markup.frame`, `mobile.markup.send`.
  - Needs the sidecar rebuilt and the PWA rebuilt (`npm run backend:stale`).
  - [ ] 🖐️ Manual QA, iPad (Home Screen PWA) and Android Chrome — the PWA pairs
    and runs on the iPad at all. An agent tab on a LaTeX project → swipe right
    from the left third → open the built PDF → **Mark up**: pages render (no
    Mark up from the project screen's drawer). A dense page renders in well
    under ~1 s (else fall back to desktop-rendered pages, plan §4.0); 100+
    pages scroll without the tab reloading; a PDF with JPX images shows them
    blank, nothing else broken. With the Pencil: strike a word and write its
    replacement, circle a figure and write "smaller", highlight a sentence; the
    page never scrolls or selects text while writing, a resting palm draws
    nothing, fingers scroll and pinch (the page re-sharpens after the pinch).
    On the phone without a pen: ✋/✎ switch, in ✎ one finger draws, two scroll.
    Close and reopen — the ink is still there; the desktop's `.tabtivity/inbox/`
    has nothing new and the PDF's mtime is unchanged. **Submit** → the chat shows
    the prompt naming the PDF; the inbox holds `…-marked.pdf` (ink, highlight
    and note visible in the desktop viewer and another PDF reader) and one
    layer PNG per marked page; reopening shows no layer. The agent edits the
    `.tex`, rebuilds and sends the PDF back with `tabtivity-send` into the same
    chat. Same on a picture (`…-marked.png` + layer) and on a PDF the agent sent
    (chat bubble → viewer → Mark up). Submit while the agent works → held and
    delivered like a typed message.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, iPad (Pencil) and a pen-less phone — markup that handles like the phone's own (2026-10-01; untested id `mobile.markup.native`; ⚠️ never run on a phone; PWA rebuild first): open a PDF from an agent tab, scroll to page 3 and pinch in → **Mark up**: the floating palette appears and the page and zoom stay where they were; **Done** → the palette goes, the marks stay on show, Mark up carries a red dot; ✕ closes the viewer. On the pen-less phone one finger draws at once and two fingers scroll and pinch. On the iPad the first Pencil stroke makes fingers scroll again; ⋯ → "Draw with the pen only" off lets a finger draw, and the choice survives a reload. The colour dot opens the colour choice; ⋯ also holds Clear page. Note tool: tap → new note; tap a note → edit it; drag a note → it follows the finger or Pencil and stays on the page at the edges (with "pen only" on, a finger drag on a note moves it, a finger drag elsewhere scrolls); Undo puts it back. Type a note and tap Done without Add → the note is kept. A picture: Mark up → Done returns to the picture.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA — the Submit prompt is worded only in the phone's settings (2026-10-02; untested id `mobile.markup.instruction`; ⚠️ never run on a phone; PWA rebuild + `backend:stale` first): Home → ⚙ This device → **Mark up prompt** reads "Default: list the changes, edit nothing until asked"; mark up a PDF built from a `.tex` beside it and Submit → the agent lists the changes and touches no file (not the `.tex`, not the PDF) until told. Edit the prompt (e.g. "Apply them to the .tex and rebuild"), Save → the row says "Your own" and the next Submit ends with that text instead; **Use the default** brings the default back. The Mark up view itself has no place to edit it.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, phone — markup rounds: Submit keeps the view open (2026-10-02; plan `docs/pdf_markup_rounds_plan.md`, handoff `docs/pdf_markup_rounds_handoff.md`; untested id `mobile.markup.rounds`; ✅ automated: `MobileMarkupRoundsCore.test.ts`, `MobileMarkupRounds.test.tsx`; ⚠️ never run on a phone; PWA rebuild + `backend:stale` first): an agent tab on a LaTeX project → files drawer → the built PDF → **Mark up** → strike a word → **Submit**: the view stays open, the stroke dims, the pill reads Sent → Agent is working… → Agent finished — PDF unchanged (the default instruction only lists). While it works circle another word and Submit → the pill says Queued, and only the new circle goes out (the chat shows the second prompt). Tell the agent in the chat to make the changes and rebuild → back in the view the pill goes working → "Agent finished — PDF changed" with **Reload PDF** → Reload: the rebuilt pages appear under the layer at the same place, the sent marks stay on show, dimmed, to check each change against — the eraser removes a checked one (⋯ **Show sent marks** hides them, ⋯ **Clear sent marks** drops them; nothing removes one automatically), unsent marks stay. Same on a PDF the agent sent with `eldrun-send` (chat bubble → viewer): Reload picks the newer copy, and closing and reopening that copy shows the layer.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop — **Mark up** in the desktop PDF viewer (2026-10-02; untested id `desktop.markup`; ✅ automated: `PdfMarkupCore.test.ts`, `PdfMarkupLayer.test.tsx`, `PdfMarkupSubmit.test.tsx`, `PdfMarkupViewer.test.tsx`, Rust `commands::pdf_markup`; ⚠️ never run live; needs a rebuilt Eldrun for `pdf_markup_submit` — `npm run backend:stale`): a local project with an agent tab → open its PDF (or the TeX workspace's PDF) → the toolbar's **✎ Mark up** (beside ▮) → a strip opens under the toolbar; draw with the mouse (pen ✎, highlighter ▭, note T: click to type, Enter adds, drag a note to move it; eraser ⌫ takes whole marks), colours, ↶/↷ and Ctrl+Z / Ctrl+Shift+Z undo strokes (not page edits), Clear page; zoom in/out — marks stay put and sharp; remarks stay visible but don't react, right-click places none; ▮ and the rail are off. **Submit** → the agent tab receives the prompt (`.eldrun/inbox/…-marked.pdf` beside the layer PNGs; open it — the marks are annotations), the strokes dim, the pill follows the tab (Sent / working / asking / Agent finished). While it works add marks and Submit again → typed into its queue at once. Let the agent rebuild the PDF: the pages do **not** repaint under the marks — the status line says the PDF changed → **Reload PDF** brings it at the same zoom and scroll, sent marks still shown dimmed; the eraser removes a checked one, nothing removes one automatically. Two agent tabs: a "Send to" picker lists both, defaulting to the one you looked at last; the pick receives the prompt. No agent tab: Submit disabled with "Open an agent tab in this project to send". The same PDF in a second pane: its Mark up says it is being marked up in another pane. Pending page edits (rail) → Mark up disabled with the reason. Remote project, root console, a box and a popout window: no Mark up button. Quit and restart Eldrun → the unsent marks are still there. A pen tablet draws with pressure; touch draws.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA — **Make these changes** + the desktop's own markup prompts (2026-10-02; plan §2.8; untested ids `mobile.markup.apply`, `desktop.markup.apply`; ✅ automated: `MobileMarkupRounds.test.tsx`, `MobileMarkupRoundsCore.test.ts`, `PdfMarkupSubmit.test.tsx`, `DesktopSettings.test.tsx`, `pdf_markup.rs` tests; ⚠️ never live). Phone: Submit marks → the agent lists the changes → the pill says Agent finished and offers **Make these changes** → tap: the go-ahead appears in the chat as your prompt, the pill follows that turn and offers no second Make these changes; when it finishes, **Reload PDF** leads. Home → ⚙ This device → Mark up prompt: the second field changes what the button sends; Use the default resets both. Desktop: Settings → Agents → **PDF markup** shows both prompts starting from the defaults; a changed Mark up prompt ends the next Submit's prompt in the agent tab; **Make these changes** in the markup strip queues the go-ahead into the target tab.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop — the agent's markup questions beside the PDF (2026-10-03; plan `docs/markup_questions_mcp_plan.md`, handoff `docs/markup_questions_mcp_handoff.md`, rationale `docs/context/markup_mcp.md`; untested id `desktop.markup.questions`; ✅ automated: `PdfMarkupQuestions.test.tsx`, Rust `services::markup_mcp`, `commands::markup_mcp`; ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale`): a local project with a fresh Claude tab → its PDF → **✎ Mark up** → draw an ambiguous arrow (or circle two words and write "which?") → **Submit**. The agent calls `markup_ask` (Claude asks to approve the tool the first time) and ends its turn; a card "The agent asks" appears under the markup strip, the pill reads "The agent asks about your marks — answer below" and **Make these changes** is off. Each question has a `?n` pin at the quoted words (in the page's top margin when the quote is not found). Click a pin → the card scrolls to its question and flashes it; **Show on page N** → the page scrolls to the pin and lights the quoted words. Click an option of a single question → the answer appears in the agent tab as your prompt ("My answers to your markup questions on `…`: 1. … → …"), the card goes, the pill follows the turn. Several questions or a "Pick any that apply." one: rows tick, **Send answers** sends them all. **Other…** → type → it goes out as `Other: …`. **Answer in chat instead** → the card goes, nothing is typed. Ask the agent to ask again before answering → the first card is replaced. Same flow in a Codex tab. Turn markup off → the card goes; back on → it is back.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, phone — the agent's markup questions in the markup view (2026-10-03; plan `docs/markup_questions_mcp_plan.md`, handoff `docs/markup_questions_mcp_handoff.md`, rationale `docs/context/markup_mcp.md`; untested id `mobile.markup.questions`; ✅ automated: `MobileMarkupQuestionsCard.test.tsx`, `MobileMarkupQuestions.test.tsx`, Rust host `markup_questions_cross_as_leaf_names_and_answers_as_indices`, `protocol::markup_questions_cross_by_tab_pair_and_answers_stay_strict`; ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale` and `npm run mobile:bundle`): as above, but Submit from the phone's **Mark up** on a PDF the agent sent (chat bubble → viewer). A card "The agent asks · n" docks at the top of the palette within ~3 s; it also shows while just reading the PDF. Pins come from the sealed frame at the quoted words (check at high zoom and on a two-column page); tap a pin → the card opens and flashes that question; **Show on page N** → the page scrolls there and the words light up briefly. Tap an option → the answer appears in the chat as your prompt and the card goes on the phone **and** the desktop. Fold the card with its head; a new ask opens it again. **Other…** with the keyboard up on a small phone: the card stays usable. Answer the same ask on the desktop first, then on the phone → "they were already answered", nothing typed. Close the desktop window (sidecar keeps running) → no card, no error.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, phone — the Focus banner for an open markup question (2026-10-03; plan `docs/markup_questions_mcp_plan.md`, handoff `docs/markup_questions_mcp_handoff.md`, rationale `docs/context/markup_mcp.md`; untested id `mobile.markup.questions`; ✅ automated: `MobileMarkupQuestionsCard.test.tsx` (banner cases); ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale` and `npm run mobile:bundle`): while an ask is open, the tab's Chat shows a one-line banner over the session facts. The agent sent the PDF to the phone: "The agent asks about <file>" with **Open** → the PDF opens in the markup view with the card. The PDF lives only in the project: "… about <file> in its markup view", no Open. An ask without a file: "… about your marks in the markup view". Answer it → the banner goes. The banner never shows while a viewer, the gallery or the file browser covers the chat.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — an answer that could not be delivered reopens its questions (2026-10-03; plan `docs/markup_questions_mcp_plan.md`, handoff `docs/markup_questions_mcp_handoff.md`, rationale `docs/context/markup_mcp.md`; untested ids `desktop.markup.questions`, `mobile.markup.questions`; ✅ automated: `reopen_undoes_only_the_answer_whose_prompt_was_not_delivered`, the delivery-failure cases in `PdfMarkupQuestions.test.tsx` and `MobileMarkupQuestionsCard.test.tsx`; ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale`): make queueing into the tab fail (e.g. fill the tab's scheduled prompts up to its cap) and answer: the desktop card stays and says the questions are still open — try again; the phone says it could not be sent and the questions are still open. Free the queue and answer again → delivered once. If the agent asked anew meanwhile, the old answer is not reopened: the desktop shows the prompt text to paste, the phone says the questions have closed.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, the Manage CLIs switch for markup questions (2026-10-03; plan `docs/markup_questions_mcp_plan.md`, handoff `docs/markup_questions_mcp_handoff.md`, rationale `docs/context/markup_mcp.md`; untested id `markupMcp`; ✅ automated: Rust `services::root_mcp` wiring tests, `services::markup_mcp` `off` case; ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale`): Settings → Agents → Manage CLIs → Advanced → **Let project agents ask about your PDF marks (MCP)** is on in fresh settings. Turn it off → a newly opened Claude tab lists no `markup_ask` (`/mcp`); a tab opened before still has the tool, and a call answers `off` naming the setting, no card appears. Turn it on → a new tab has the tool again. A remote project's tab, a VM project and a container tab never have it.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — the eraser takes part of a stroke (2026-10-04; untested ids `desktop.markup.eraser`, `mobile.markup.eraser`; ✅ automated: `MobileMarkup.test.ts` (cutStroke, eraseAlong, ceiling fallback, stylusErases), `MobileMarkupRoundsCore.test.ts`, `PdfMarkupLayer.test.tsx` (pen eraser end); ⚠️ never run live; phone needs `npm run mobile:bundle`): Mark up → the eraser button shows an eraser icon (no longer ⌫) and a hint while armed; on the desktop the cursor is a ring. Draw a long stroke, rub across its middle → only the rubbed part goes and two strokes are left; rub its end → it gets shorter. A fast swipe across several strokes cuts every one it crosses. A box or a note it touches goes whole. Undo puts the whole rub back in one step. Shown sent marks (Show sent marks on) are cut the same way; hidden ones are untouched. Submit after erasing → the baked `-marked.pdf` shows the cut strokes. Pen tablet with an eraser end (Wacom, Surface pen): with the pen tool armed, flip the pen → its eraser end erases; the tip still draws.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — a quick text correction: page pictures, the words under each mark, SyncTeX lines (2026-10-04; untested ids `desktop.markup.anchors`, `mobile.markup.anchors`; ✅ automated: `MobileMarkupAnchors.test.ts`, `MobileMarkupRounds.test.tsx` (frame `snapshot`/`text`), `PdfMarkupSubmit.test.tsx`, Rust `anchors_and_synctex_name_each_mark`, `anchors_are_bounded_one_line_and_one_per_mark`; ⚠️ never run live; needs a rebuilt Tabtivity — `npm run backend:stale` — and `npm run mobile:bundle`): a LaTeX project built with SyncTeX (`latexmk -synctex=1`) and an agent tab → its PDF → **Mark up** → strike a word, underline one, circle one, a caret between two words, a highlighter box, a note in the margin → **Submit**. The prompt lists "Each marked page, with my marks drawn on it" (open one `-p<n>-marked.png`: the page with the marks on it), then one line per mark — "line through "…" in "…" — `chapters/intro.tex:42`", "line under", "circled", "mark at "the lazy"", "highlight on", "note "…" beside "…"" — with lines that point at the right `.tex` and line; the marked copy is only named (no `@`). The agent's list comes back noticeably quicker than before. A two-column page: a line's context holds no words of the other column. A PDF the agent sent to the phone (outbox copy): the words, no `.tex` lines. A scanned PDF with no text: pictures only, no mark lines.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — a rebuilt PDF loads under the marks on its own (2026-10-04; untested ids `desktop.markup.autoReload`, `mobile.markup.autoReload`; ✅ automated: `PdfMarkupCore.test.ts`, `PdfMarkupViewer.test.tsx` (three reload paths, on and off), `MobileMarkupRounds.test.tsx`; ⚠️ never run live; phone needs `npm run mobile:bundle`): desktop — Mark up, Submit, let the agent rebuild: the new pages appear under the marks by themselves at the same zoom and scroll, sent marks dimmed; while typing a note it waits and the strip offers **Reload PDF** instead. Settings → Agents → **PDF markup** → "Reload the PDF under your marks when it changes" off → back to the Reload offer. Phone — Submit, let the agent rebuild and finish: the view reloads by itself with "The agent's new PDF is loaded under your marks."; nothing happens when the PDF is unchanged; ⋯ → **Reload when the agent finishes** off → the pill offers **Reload PDF** as before, and the choice survives closing the view.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — subagent mode: each Submit goes to a new subagent (2026-10-04; untested ids `desktop.markup.subagents`, `mobile.markup.subagents`; ✅ automated: `PdfMarkupSubmit.test.tsx`, `MobileMarkupRounds.test.tsx`; ⚠️ never live; phone needs `npm run mobile:bundle`). Turn on Settings → Agents → PDF markup → **Hand each Submit to a new subagent** (phone: ⋯ → **Each Submit to a new subagent**), mark a PDF in a Claude tab and Submit: the agent starts a background subagent and ends its turn within seconds (pill goes done); mark more and Submit again at once — a second subagent starts while the first still works; both rounds' changes land without one undoing the other; answer a `markup_ask` card and press **Make these changes** — each reaches the round's subagent; with the switch off a Submit is handled by the tab's agent itself as before.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, iPad (Pencil), an Android pen phone and a pen-less phone — the pen switches Mark up on; PDFs open in (2026-10-04; untested ids `mobile.markup.penSwitch`, `mobile.markup.opensIn`; ⚠️ never run on a phone; `npm run mobile:bundle` first): open a PDF from an agent tab's chat or files drawer (reading, the ✕ and Save/Share in the head). On the iPad touch a page with the Pencil and write → the palette appears and the stroke you began is on the page (a Pencil tap leaves a dot); the page did not scroll under it; fingers still scroll and pinch; **Done** → reading again, the stroke on show. The Pencil on the grey gap between pages still scrolls. A PDF from the project screen's 🖼 / 📁 (no agent tab) behaves the same. A PDF that cannot be marked (no Mark up button): the Pencil scrolls as before. Android with an S Pen: the same (unknown whether Chrome lets the pen scroll the page first — note it). Pen-less phone: a finger only scrolls; Mark up still needs the tap. Home → ⚙ This device → **PDFs open in** reads Automatic. Automatic: on the iPad (after a Pencil stroke, pen-only) a PDF opens straight in Mark up; on the pen-less phone it opens reading, unless the PDF has marks not yet submitted → it opens in Mark up; after Submit it opens reading again. **Reading**: always reading, the pen still switches. **Mark up**: always marking, the ✕ still closes. The choice survives a reload of the PWA.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual QA, desktop and phone — **Apply marks directly** and **Undo** (2026-10-04; plan `docs/pdf_markup_direct_apply_plan.md`, handoff `docs/pdf_markup_direct_apply_handoff.md`; untested ids `mobile.markup.undo`, `desktop.markup.undo`; ✅ automated: `MobileMarkupRounds.test.tsx`, `MobileMarkupRoundsCore.test.ts`, `PdfMarkupSubmit.test.tsx`, `DesktopSettings.test.tsx`, Rust `services::markup_rounds` + host route test; ⚠️ never live; needs the rebuilt backend and phone bundle — `npm run backend:stale`). A LaTeX project in git: mark a typo and Submit → in one turn the agent edits the `.tex`, rebuilds (phone: and sends the PDF back); the pill says Agent finished and offers **Undo**, never Make these changes. **Undo** → a sheet (desktop: a dialog) lists the files and says the PDF goes back → **Undo** → the `.tex` and the PDF are back as before, the PDF reloads under the marks (which stay), a note "I undid your edits …" appears in the chat and no new round starts. Edit the `.tex` by hand after a round → **Undo** says "Can't undo — `….tex` changed since. Nothing was changed." and leaves the file alone. A folder that is not a git repository (phone: also a remote project or a picture) → the line "No undo here (…) — the agent lists the changes first." and **Make these changes** as before. Switch off (phone: Home → ⚙ This device → Mark up prompt → **Apply marks directly**; desktop: Settings → Agents → PDF markup) → list first as before; the Mark up prompt field starts from the list default while off and the apply default while on.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bu — A plain `opencode` tab's chat fills its facts and shows it working** (2026-10-01;
  ✅ code-complete, automated tests passing — `MobileOpenCodeMini.test.ts`
  "full TUI composer", `MobileAgentBusy.test.ts`; ⚠️ never run on a phone;
  untested id `mobile.focus.openCodeComposer`). The phone's chat for a plain
  (full-screen) OpenCode tab showed `Status Model Mode` placeholders and no
  working row while it answered: everything read the `--mini` status row
  only. `openCodeComposer`/`openCodeFullFooter` (`openCodeMini.ts`) now read
  the full TUI's composer — agent row `Build · <model> <provider> · <variant>`
  (the provider cut off by its muted colour) and the footer under it
  (`… esc interrupt …  12.3K (5%)  ctrl+p commands`); `agentBusy` accepts the
  interrupt hint as a mid-row column. Both OpenCode readers now flip the
  printed share *used* into context *left*, which the fact button says.
  Shapes are read from the 1.18.34 source, not a capture (no OpenCode in the
  fence).
  - [ ] 🖐️ Manual phone QA (PWA rebuild + restart first) — on a plain
    `opencode` tab, Chat view: the fact buttons show the model (without its
    provider), the agent (`build`/`plan`) and, after a first answer, the
    context left; send a prompt → a "… is working" row shows until the answer
    lands; the status-line swipe shows the composer's two rows. Tab in the
    terminal to Plan → the mode follows.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bv — A typed Other… answer in a multi-pick markup question can be
  unticked** (✅ fixed 2026-10-03 in review 1: a ticked Other… row's tap
  unticks it, a further tap opens the field — `QuestionRows` sends a picked
  free-text row to `onPick`; ⚠️ never run on a phone; from the markup questions MCP,
  `docs/context/markup_mcp.md`). In the phone's markup questions card
  (`MarkupQuestionsCard.tsx`), once Other… holds typed words on a
  "Pick any that apply." question, tapping its row again does not untick
  it; the reader can only retype it or use **Answer in chat instead**. The
  pick model already supports it (`toggleOther` clears a set Other…); the
  row's tap goes to the text field instead. Make a second tap on a ticked
  Other… row untick it, as the desktop card's row does.
  - [x] 🤖 Automated test (`MobileMarkupQuestionsCard.test.tsx` "unticks a typed Other…")
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bw — The Focus banner can open a markup question's project file**
  (built 2026-10-03, never live: with the file browser switched on the
  sidecar hands the banner a sealed files row — `files::entry`, its folder
  token and trail — and **Open** shows it in the files viewer with Mark up;
  the picture part below stays open. From the markup questions MCP,
  `docs/context/markup_mcp.md`). The banner "The agent asks about <file>"
  has **Open** only when the tab's outbox holds the file: the phone gets the
  ask's leaf name, never a path, and the project file browser walks sealed
  folder tokens, so a leaf cannot find a project file. Let the sidecar mint
  a files token for the ask's file (it knows the project-relative path when
  it asks the window) behind the file browser's own gates, so Open works for
  a project PDF too. Also: a picture opened from the banner opens read-only
  and needs a tap on **Mark up** before the card shows.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bx — Files sent from the phone show as pictures, in the composer
  and in the chat** (2026-10-04; untested ids `mobile.composer.thumbnails`,
  `mobile.chat.inboxPreviews`). Attach a photo, a PDF and a desktop
  screenshot in a Focus agent tab: each shows as a thumbnail above the
  composer (dimmed with a spinner while it travels, ✕ once landed), never as
  `@…` text in the input; leave the screen and come back — the draft returns
  with the thumbnails. Send: the prompt's bubble shows the photo(s) as a
  picture/album with your words as the caption and the PDF as a card, no
  `@.tabtivity/inbox/…` text; tap opens them full screen. An older prompt with
  `@.eldrun/inbox/…` shows its picture too; a file deleted from the inbox
  shows "No longer in the project inbox". Agent → phone files keep showing
  as picture bubbles on the left (31bj).
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31bz — The phone's ⎇ Git overview, and the ＋ sheet's worktree row**
  (2026-10-04; untested id `mobile.project.gitOverview`;
  `docs/mobile_git_overview_plan.md`). Needs the frozen dev build (the
  sidecar serves the new route). In a git project with one linked worktree
  (desktop Git panel → Worktrees → add) and an agent tab running in it: on the
  phone tap the project's name → **⎇ Git**. The head line shows the project
  folder's branch, `↑n ↓n` against its upstream (or "no upstream") and its
  dot; **Worktrees (2)** lists the project folder first (tinted, "Project
  folder · Main"), then the linked one with its branch, dot and "1 tab";
  make the linked one dirty, tap **↻ Refresh** after 5 s — its dot turns red.
  **Branches** puts ● on the checked-out one and "in <worktree>" on the
  linked one's branch; **Remote branches** (folded) leaves out `origin/x`
  where a local `x` exists. Detach the project folder (`git checkout
  --detach`) → "Detached at <sha>". A folder outside git → "Not a git
  repository"; a box's name menu has no Git entry. Close the desktop window:
  the sheet still answers. Then tap **＋** in the same project with the window
  open: **Agents start in** now lists the project folder and the linked
  worktree (it never listed any before), and starting an agent there opens it
  in that worktree. Also check the alert strip on the phone shows the
  desktop's alerts again (its row ids were refused the same way).
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31cb — Mobile access per phone: a project or box reaches only the
  phones picked for it** (2026-10-04; ✅ code-complete and automated tests
  passing, ⚠️ live QA pending — and a rebuild + restart first: the sidecar,
  two commands and a new one changed; untested id `mobile.phonePicker`;
  design `docs/context/mobile_access.md`, plan
  `docs/mobile_device_scoped_access_plan.md`). The side panel's phone button
  opens a picker — All phones / Only these phones (checklist of the paired
  phones) / Turn off — and Settings → Mobile shows "All phones ▾" / "N phones
  ▾" / "No phones ▾" beside each enabled project and box, opening the same
  picker. The sidecar filters every phone route, the terminal re-check and
  agent pushes by the list. Locked by `MobileProjectAccess.test.tsx`,
  `MobileBoxAccess.test.tsx` and the `discovery.rs` / `host.rs` / `push.rs` /
  `commands::projects` tests.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test — pair two phones (A, B). Limit a project to A: B's
    Projects list drops it within a poll, an old link or notice on B says it
    is no longer shared, and an agent turn in it notifies A only. Open one
    of its terminals on A, then switch the list to B only (tick B, untick
    A): A's terminal closes within ~5 s ("access … withdrawn"). Same for a box
    from Settings → Mobile. Revoke B while a project lists only B: the row
    reads "No phones ▾" (amber) and no phone sees it; All phones in the
    picker brings it back to both.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31cd — Per paired phone: hide To-do / Calendar / Mail, and its own
  project list** (2026-10-04; untested ids `mobile.deviceSections`,
  `mobile.deviceProjects`). Settings → Mobile → Paired devices, under a phone:
  press **Mail** off — that phone's tab bar loses Mail within 30 s (or on
  return to the app), a mail alert row leaves its Home strip, and an old
  bookmark/notification into Mail answers "The desktop has turned this section
  off for this phone."; another paired phone still has Mail. Turn **Calendar**
  off: that phone gets no reminder push, the other does. Under **Projects on
  this phone**: **Disconnect** an All-phones project — it leaves this phone's
  list and the other phone keeps it (the project's ▾ button now reads
  "1 phone"); Disconnect the only phone of a project — its access turns off.
  **Add project ▾** — an off project opens for this phone alone; a project
  limited to the other phone gains this one.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31ca — The Focus chat lists every file it carried** (2026-10-04;
  untested id `mobile.chat.sentIndex`). Needs the frozen dev build (the PWA is
  baked in). In a Focus agent tab (Chat → Session) send a photo from the
  phone, then ask the agent to `tabtivity-send` a file back: a **Files (2)**
  chip appears in the strip over the chat (beside **Subagents (n)** when the
  session has any). Tap it: one row per file, newest first — picture or
  PDF/≡/↓ badge, the sent name (no stamps), **From the agent** / **From you**,
  age and size; tap a row → it opens full screen; a binary saves instead.
  Opening **Subagents** closes the file list and back. A file another tab
  sent stays out of the list (gallery only); a chat with no files shows no
  chip.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **31by — Local models from the phone** (2026-10-04;
  ✅ code-complete, automated tests passing — `ollama` / `local_models` /
  `protocol` / `host` Rust tests, `MobileLocalModels.test.tsx`,
  `MobileLocalModelsGate.test.tsx`, `MobileLocalModelsSheet.test.tsx`,
  `MobileMutationList.test.ts`, `MobileApiDeadlines.test.ts`; ⚠️ not
  verified on a phone). Plan
  `docs/mobile_local_model_control_plan.md`. Home → **Local models** lists
  the desktop's installed Ollama models (size, parameters/quantization,
  idle / loading / loaded / failed, GPU · N % GPU · CPU, stays loaded /
  unloads in N min, the model new local-model tabs use) with **Load**
  (Ollama picks the device, `keep_alive -1`), **Unload** (no confirmation)
  and **Start Ollama** (`systemctl --no-ask-password`, else an owned
  `ollama serve` that quit stops). Everything goes through the desktop
  window (`lib/mobileLocalModels.ts`); no window → 503 and "open the app",
  no headless fallback. Pull/delete/anything else → 400
  `unsupported_action` before the desktop is asked. Desktop switch Settings
  → Mobile → **Local models from the phone** (under Project access, unset =
  on) → 403 and the Home row is left out. Untested ids
  `mobile.localModelsGate`, `mobile.localModels`, `mobile.localModels.start`.
  Needs the backend restarted and the Mobile host updated (both Rust
  halves: `commands::ollama` + the bridge in the window, the routes in the
  sidecar); the PWA is rebuilt (`npm run mobile:bundle`).
  - [ ] 🖐️ Manual phone QA — Home → Local models lists every installed
    model with its size; Load one → "Loading into memory…" then "On the
    GPU · Stays loaded until unloaded", and the desktop's Models & agents
    menu shows the load while it runs; a load that outlasts the phone's
    15 s wait is not shown as failed — the list is read again and keeps
    refreshing fast; Unload → idle on both; with Ollama stopped, Start
    Ollama starts it without a password dialog on the desktop, and quitting
    the app stops a server it had to start itself; Settings → Mobile →
    Local models from the phone off → the row disappears (and comes back
    when switched on); with the desktop window closed the row and the sheet
    say to open the app (against a desktop build older than this they say
    the same, since it drops the request unread); nothing on the phone offers download,
    update or delete; loading a single model with none resident re-points
    the desktop's roles (expected).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [ ] **31cc — To-do board project names per phone** (2026-10-04; follow-up
  of 31cb, out of its scope). The phone's to-do board lists every registry
  project's name in its project picker and on card tags, Mobile switch or
  not (`MobileBridgeHost` `todoBoard` → `publicProjects`, headless
  `headless::project_names`), and cards carry their project's opaque id. A
  phone limited away from a project still reads its name there. Decide
  whether the board should hide projects the phone cannot reach (switch off
  or not on its list), then filter both the desktop answer and the headless
  one per device (`Catalog::for_device` already knows the set).

*Not coming to the phone (decided, not forgotten — see
`docs/mobile_box_parity_plan.md`): editing a box from the phone (membership,
rename, Dissolve), listing a box's members as project rows, a per-member
status column, and box-folder file browsing.*
