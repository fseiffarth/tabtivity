## Group I — Backend Runtime Follow-Ups
*Files: `src-tauri/src/services/` (`project_runtime.rs`, `terminal_service.rs`,
`window_service.rs`), `commands/`, `.tabtivity/sessions/` mirrors, `schema/`. The
first backend runtime boundary pass is implemented: project switching is
coordinated through `switch_project_runtime`, core services live under
`services/`, tab/file/layout/window metadata is mirrored into
`.tabtivity/sessions/`, download routing is part of switching, and the old
`switch_project_windows` command is deprecated. Related to #24 (session restore),
but backend-owned.*

32. **Backend runtime follow-ups.** Remaining backend-side work on the runtime
    boundary, each independently pickable:
    - Backend-owned PTY resurrection after app restart, including dead-session
      detection and a clear frontend policy (respawn, mark dead, or manual
      restart).
    - Terminal/agent transcript storage if restart recovery needs readable
      historical output rather than metadata-only restoration.
    - ⛔ ~~Promote `.tabtivity/` runtime files from optional mirrors to the primary
      source once compatibility reads from `project.json` are validated.~~
      **OBSOLETE — superseded by the sandbox-hardening decision, which went the
      opposite way.** The state dir is now primary and the project-tree copy is
      export-only, enforced by `tests/project_tree_intent.rs` (see
      `schema/session.rs:8-16`, `services/terminal_service.rs`). Promoting
      in-tree files back to primary would reintroduce the attacker-controlled
      -input problem that change was made to close.
    - Durable project-window metadata under `.tabtivity/sessions/windows.json`
      beyond registry IDs (window role/origin, restore command, optional file
      target, future geometry/focus fields).
    - Move file-navigation runtime state backend-side once switching is stable:
      center file tabs, right-panel folder, breadcrumbs, history.
      **Mostly done** — center file tabs and the right-panel folder now live
      backend-side (`services/project_runtime.rs:317,352,368`,
      `schema/session.rs:49-58` `FileTabSession`, persisted as `filetabs.json`).
      Remaining: breadcrumbs and history.
    - Focused tests for backend runtime switching with mocked services
      (time flushing, old-project save, project-window hide/show, download
      routing, root runtime handling, no respawn of already-live tabs).
    - 🐛 **Main-process heap corruption on project switch (open).** Five
      crashes 2026-09-17..23 (v0.1.68–0.1.80), all on the GTK main thread: four
      SIGABRT from glibc's heap check (`malloc(): smallbin double linked list
      corrupted`, `unaligned tcache chunk detected`) inside `realloc`/`malloc`
      reached from a WebKit/libsoup callback, one SIGSEGV at `addr=0x28` in
      `gtk_main_do_event`. The last one (2026-09-23 13:53) hit while switching
      to a plain local project. The aborting frames are victims; the writer is
      unknown. Ruled out by reading: Tabtivity's own Linux `unsafe` (all plain
      syscalls), GTK use off the main thread (drag, presenter, subwindow and
      print paths all run on it; `tauri-plugin-drag` uses
      `run_on_main_thread`), the switch worker's window calls (all go through
      tauri-runtime-wry's proxy). Suspects: WebKitGTK 2.52.6 / Mesa 26.0.8 in
      the UI process (radeonsi, popout windows created and parked on Wayland
      during a switch — the series began with d231269), libdbus via
      `dbus-secret-service`. Every crash ran a `(deleted)` binary, and a
      rebuild of the same commit does not reproduce the layout, so none could
      be symbolized; `scripts/retain-dev-build.sh` + `commit=` in the crash
      header now keep the next one resolvable
      (`scripts/crash-symbolize.sh`). Next: symbolize the next crash; if the
      Tabtivity frames still point at a victim, run the frozen build once with
      `GLIBC_TUNABLES=glibc.malloc.perturb=165:glibc.malloc.tcache_count=0`
      (use-after-free shows at the use) or `WEBKIT_DISABLE_COMPOSITING_MODE=1`
      for a session to bisect Mesa out.
      - Sixth, 2026-09-23 17:05 (1a36cae, not retained — retention began with
        e3d4ad9): `smallbin double linked list corrupted` in `realloc` under a
        WebKit→Rust IPC callback, while an agent tab was preparing a commit
        (the 13:53 and 2026-09-22 16:33 crashes also sat minutes before a
        commit's freeze; the freezes started *after* the crashes, and
        `install` leaves the running inode alone, so the rebuild itself is
        not the writer). On 2026-09-18 Orca crashed one second before Tabtivity.
        No crash ever left a core: the session's soft core limit is 0, and
        apport drops a process whose exe path was replaced ("executable was
        modified after program start"). Now the launcher raises the limit and
        `package-dev.sh` no longer installs over a running window (the next
        launch adopts), so the next crash's core lands in
        `/var/lib/apport/coredump/` — inspect the corrupted chunk with gdb
        against `dev-builds/tabtivity-<commit>`.
      - **Diagnosed from the first core (2026-09-30 04:20, idle window):**
        the freed 0x50 chunk was an `Rc<RefCell<HashSet<WindowId>>>` — tao's
        Linux `EventLoopWindowTarget.windows` (borrow flag 0, 4 buckets of
        `u32`, 2 items), its strong count bumped +4 after the free, next to
        the `gdk::Display`/`GtkApplication` GObjects and Arcs of a
        tauri-runtime-wry `Context` (~490 copies on the heap).
        `Context: Clone` clones that target on every thread that clones an
        `AppHandle`/`Window` (`DispatcherMainThreadContext` is `unsafe impl
        Send + Sync`), so non-atomic `Rc` counts raced to 0. Fixed by a
        vendored tauri-runtime-wry 2.11.3 (`src-tauri/patches/`, root
        `[patch.crates-io]`) holding it behind an `Arc`; upstream `dev` still
        has it. 🖐️ Run the patched build for a few days of normal use; close
        this bullet if no heap abort recurs.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)

---
