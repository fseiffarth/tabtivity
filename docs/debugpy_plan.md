# Python debugging with a bundled debugpy — plan

Status: plan only (2026-10-20). No code yet. Never run live.

The code viewer's **Debug** button today types `python -m pdb -c "b f:N" …`
into a terminal tab (`src/lib/terminal/pythonRun.ts`, TODO group-m #87).
This plan replaces that with a real debugger built on **debugpy**, which
Tabtivity ships itself. The user gets a step toolbar, a call stack, a
variables tree, a debug console, exception breakpoints and conditional
breakpoints, all in a panel under the editor. It keeps working wherever
Run works today: locally, on an SSH host, and in a project container.

## Why

pdb in a terminal works, but you can only see the program's state by typing
commands at a prompt. You can't add a breakpoint while the program runs
without typing it, a stop is not shown in the editor, and there is no
variables view. #87 skipped a DAP client on purpose to stay small. A DAP
client is now worth the cost because debugpy does the hard part: it hooks
into the program, handles threads, subprocesses and `justMyCode`, and runs
on every OS.

## How debugpy fits (the mechanism)

debugpy is a Python library. It runs **inside the program being debugged**,
so it must exist on the machine where the script runs. It can't live in
Tabtivity's own process. Three processes take part, and all of them run on
the **run machine** (local, the SSH host, or the container):

1. **The adapter**: `python -m debugpy.adapter`. It speaks DAP on its
   stdin/stdout. Tabtivity's backend spawns it and relays DAP frames
   (`Content-Length` framing, the same framing as Copilot's LSP in
   `services/copilot/rpc.rs`).
2. **The launcher plus the program.** The `launch` request carries
   `console: "integratedTerminal"`. The adapter then sends the
   **`runInTerminal` reverse request** back to Tabtivity: "run this argv
   with this env and cwd in a terminal". Tabtivity opens that as the
   ordinary run tab (`openPythonTab`). So `input()`, Ctrl+C, the traceback
   that stays on screen, the HPC login-node guard and remote/container
   placement all stay exactly as they are today.
3. The launcher connects back to the adapter on `127.0.0.1:<port>`. This
   works because the adapter and the tab run on the same machine: the same
   ControlMaster connection for SSH, and the same container (one network
   namespace) for Docker.

## Fixed decisions

Reviewers may not undo these. The user chose 1–4 on 2026-10-20, asked as
questions. 5–12 are routine decisions made in planning.

1. **debugpy is always bundled.** Tabtivity ships one pinned debugpy and
   never uses or changes the project's environment. A copy in the env is
   ignored: the bundled path comes first on `PYTHONPATH`. Nothing is ever
   `pip install`ed.
2. **pdb is the fallback.** If debugpy can't run (the interpreter is older
   than the floor, staging failed, or the adapter died during the
   handshake), Debug falls back to today's pdb terminal path and shows a
   one-line notice saying why. `buildDebugCommand` stays as that fallback;
   there is no separate "Debug (pdb)" button.
3. **The UI is a panel under the editor** of the viewer that started the
   session: a toolbar (continue/pause, step over/into/out, restart, stop),
   the call stack, variables, and the console. The program's I/O stays in
   its terminal tab. Every open viewer of the paused file shows the current
   line.
4. **v1 scope:** breakpoints, stepping, call stack, variables, plus
   - breakpoints in **every open `.py` viewer** of the project, not only the
     launched file's;
   - a **debug console** (`evaluate` in the selected frame) and **watch
     expressions**;
   - **exception breakpoints** (the filters the adapter advertises,
     usually *Uncaught* and *Raised*);
   - **conditional breakpoints**: condition, hit count and logpoint, edited
     by right-clicking the gutter.
5. **Pinned version: debugpy 1.8.21**, the universal
   `py2.py3-none-any` wheel (~5.3 MB, MIT). It is the last release that
   supports **Python ≥ 3.8**. 1.8.22 needs ≥ 3.10, which would lock out
   RHEL 9's system 3.9, common on clusters. The wheel lives at
   `src-tauri/vendor/debugpy/debugpy-1.8.21-py2.py3-none-any.whl` and is
   embedded with `include_bytes!`, so the server daemon has it too. Its
   blob id goes in `scripts/privacy-reviewed-binaries.txt`. It gets an entry
   in `docs/third_party_update_checklist.md`. The upstream LICENSE and
   ThirdPartyNotices files sit next to it.
6. **Staging is per machine and per version, and done once.** A marker
   file `.complete` is written last, so an interrupted copy is redone, not
   trusted.
   - Local: the backend extracts the wheel with the `zip` crate into
     `<state_dir>/debugpy/1.8.21/`.
   - SSH host: `$HOME/.cache/<slug>/debugpy/1.8.21/`. The wheel is streamed
     over the ControlMaster connection's stdin (`cat >`) and extracted with
     the **target's own interpreter** (`<interp> -m zipfile -e`), so the
     host needs no `unzip`.
   - Container: the same streamed copy through `docker exec -i`, into
     `/tmp/<slug>-debugpy/1.8.21/`. The container is ephemeral, so the
     marker check makes the first debug after a container restart re-stage.
   - These are Tabtivity's own cache paths. No other app's paths are
     touched.
7. **The backend builds every argv.** The renderer never sends an
   interpreter path or a command. `debug_start` takes
   `{ projectId, probeDir, location }`, resolves the interpreter through
   `commands::python::python_interpreter_for` (the one source of the
   interpreter ranking), checks the Python version, stages debugpy, and
   spawns the adapter. The DAP `launch` arguments come from the renderer,
   as they must, but they only ask the adapter to run a Python program. A
   renderer can already open a shell tab, so the attack surface does not
   grow.
8. **Where the adapter runs must match where the tab runs.** One resolver
   answers "which machine does a tab with this
   `{projectId, location, cwd}` land on": local, `RemoteTarget`, or the
   session container. It is factored out of the PTY path
   (`ssh_exec::wrap_pty_options` / `remote_target_of`,
   `sandbox::wrap_pty_options_docker`), and both the PTY path and the
   adapter spawn use it. The adapter never re-derives remoteness from a
   path.
9. **The transport is a thin byte relay; the DAP logic is TypeScript.** The
   Rust session only frames and relays (stdout → event
   `debug://message {sessionId, message}`; command `debug_send` → stdin),
   with Copilot's frame bounds (8 MiB per frame, 8 KiB of headers). The
   Content-Length reader/writer moves out of `copilot/rpc.rs` into a shared
   `services::content_length` module that both use. No second copy.
10. **A debug session is a process tied to the app's lifetime.** Adapter
    children join `RunEvent::Exit` teardown and are reaped with their whole
    subtree. Closing the run tab ends the session, and `debug_stop` kills
    the adapter. Re-debugging a file replaces its previous session, the
    same way `openPythonTab` replaces the previous tab.
11. **Breakpoints stay in each tab's `ViewerState`.** The shape widens from
    `number[]` to `(number | { line, condition?, hitCondition?,
    logMessage? })[]`. A bare number still reads as a plain breakpoint, so
    old tabs round-trip. A live registry (`src/stores/breakpoints.ts`)
    gathers the breakpoints of every open viewer, and the session sends
    them with `setBreakpoints` per file. A change during a session is sent
    right away. Breakpoints in a closed file don't count (decision 4 says
    open viewers).
12. **The feature stays behind the experimental `python_run_debug` flag**,
    and the panel carries an `UntestedTag` (`python-debugpy` row in
    `src/lib/untested.ts`).

## Paths across machines

Breakpoints are set on the **browsed** path, while debugpy sees paths on the
**run** machine. Today's `pythonRunPlan` already re-expresses a cross-side
run project-relative. Two pure helpers next to it,
`toRunPath(plan, browsed)` and `fromRunPath(plan, runPath)`, use the same
mirror/host-root logic:

- **Outgoing** paths (`setBreakpoints` sources, the `launch` program) go
  through `toRunPath`.
- **Incoming** paths (`stackTrace` frames, `stopped`) go through
  `fromRunPath`, which picks the viewer to show or open (`jumpToSource`).
- A frame outside both roots (site-packages, stdlib) opens read-only if the
  run machine is local. Otherwise it shows the frame without a source link.
  `justMyCode: true` (the default) keeps such frames rare.

## Steps

### D0 — verify debugpy's behaviour (no code; about ½ day)

Do this by hand against the real wheel, extracted to a scratch directory,
using a Python 3.8 venv and a current one. Record the results under this
heading:
- `PYTHONPATH=<dir> python -m debugpy.adapter` speaks DAP on stdio, and
  `initialize` with `supportsRunInTerminalRequest: true`, then `launch`
  with `console: "integratedTerminal"`, produces `runInTerminal`. Write
  down that request's argv and env shape: does the launcher's argv point
  into `<dir>`, and does the env already carry `PYTHONPATH`, or must the
  tab add it?
- The `exceptionBreakpointFilters` that `initialize` returns.
- Running the launcher argv from a different shell on the same machine
  connects back to the adapter. That is the "same machine" assumption in
  the mechanism section.
- Windows: the same round trip with `python.exe`, with argv quoting through
  `cmd.exe` (`shellQuote(…, "windows")`).

### D1 — backend: vendor, stage, spawn, relay (about 2 days)

- `src-tauri/vendor/debugpy/`: the wheel, LICENSE, ThirdPartyNotices,
  plus the privacy-reviewed blob id.
- `services/content_length.rs`: framing moved out of `copilot/rpc.rs`,
  which then imports it. Its existing frame tests move with it.
- `services/debugpy/mod.rs` (AppHandle-free, unit-tested):
  `VERSION`, the per-target cache dir, the stage script (marker check →
  `mkdir -p` → `cat >` → `-m zipfile -e` → `touch .complete`), the version
  probe (`-c 'import sys; print(*sys.version_info[:2])'` → refuse
  `python_too_old` below 3.8), and the adapter argv per target:
  - local: `<interp> -m debugpy.adapter` with `PYTHONPATH` set;
  - SSH: a new `ssh_exec::ssh_stdio_args`, the `-T` sibling of
    `ssh_pty_args`, with the same ControlMaster and `authorize_dial`
    policy;
  - container: `docker exec -i` (no `-t`), built next to
    `sandbox::docker_exec_args`.
- The run-machine resolver from decision 8, with `wrap_pty_options`
  rewritten to use it. Its existing tests must stay green unchanged.
- `services/debugpy/session.rs`: spawns the child with piped stdio, runs a
  frame reader task → `ctx.emit("debug://message", …)`, a writer, and a
  bounded stderr ring for error messages. Exit emits `debug://ended
  {sessionId, code, stderrTail}`. A registry keyed by session id is reaped
  at `RunEvent::Exit`.
- `commands/debug.rs`: `debug_start`, `debug_send`, `debug_stop`, each
  `#[cfg_attr(feature = "desktop", tauri::command)]` taking
  `tauri_host::Ctx`. Each gets a `Core` row in `services::command_class`,
  and `commandClasses.ts` is regenerated.
  - `debug_start` returns `{ sessionId, interpreter, pythonVersion }`, or a
    refusal code: `python_too_old`, `stage_failed`, or `spawn_failed`.
  - `debug_send` accepts only a JSON object of type `request` or `response`
    and refuses anything else.
- Tests: the stage script text, the argv for each of the three targets
  (cross-OS: `Path::join`, programs compared by file stem), the version
  probe parse, the frame relay with an in-memory duplex, and the registry
  reap. A `#[ignore]` integration test runs the real adapter against
  `python3` when one exists.

### D2 — frontend core: DAP client and session (about 1½ days)

- `src/lib/debug/dapClient.ts`: `seq` / `request_seq` correlation, events,
  and reverse requests over `invoke("debug_send")` + `listen`. Both sit
  behind a small transport interface so tests inject a fake.
- `src/lib/debug/pythonDebug.ts` (takes over `debugPythonFile`):
  1. `guardRunHost`, then `debug_start`. A refusal falls back to pdb
     (decision 2).
  2. `initialize` → `launch { program, args, cwd, console:
     "integratedTerminal", justMyCode: true }`.
  3. `setBreakpoints` for every file in the registry →
     `setExceptionBreakpoints` → `configurationDone`.
  4. `runInTerminal` → `openPythonTab` with the adapter's argv
     (shell-quoted per platform), env and cwd, plus the existing
     `PY_TARGET_ENV` / `PY_MODE_ENV` markers. Reply with the tab's pid if
     the PTY reports one, else with `{}`.
  5. `stopped` → `threads` / `stackTrace` / `scopes`, with `variables`
     loaded lazily when a node is expanded.
  6. `terminated` / `exited` / `debug://ended` close the session. Closing
     the run tab sends `disconnect` and then `debug_stop`.
- `src/stores/debugSession.ts` (Zustand): sessions by id, with state,
  current frame, stack, variables cache, console lines, watches and
  exception filters. `src/stores/breakpoints.ts`: the live registry from
  decision 11.
- `toRunPath` / `fromRunPath` in `pythonRun.ts`.
- `ViewerState.breakpoints` widened (decision 11) in `src/types/index.ts`
  and in the Rust `TabEntry` passthrough (`extra`, flattened). Old shapes
  get a round-trip test.
- Tests: the client (correlation, a reverse request, out-of-order replies),
  the session's request order against a scripted fake adapter, the
  fallback on each refusal code, the path mapping on local, remote and
  cross-side plans, and the breakpoint shape round-trip.

### D3 — UI (about 2 days)

- `src/components/embed/DebugPanel.tsx`, docked under the editor in
  `FileViewerPane`:
  - the toolbar;
  - "paused at file:line" / running / exited;
  - the call stack (a click selects the frame and opens its file at the
    line);
  - the variables tree;
  - the console (an input that runs `evaluate` in the selected frame, plus
    output events);
  - watches;
  - exception filter toggles.

  It reuses the side panel's tree and row classes and the shared
  menu/dialog scheme (see the "copy the working sibling" memory), with
  styles in `src/styles/files-panel.css`. Its work is gated on
  `PaneVisibleContext` and catches up when the pane is shown.
- The editor gutter in `FileViewerPane` (~line 5126):
  - a hollow dot for a breakpoint the adapter did not verify, and a tooltip
    for a conditional one;
  - a current-line arrow and line highlight in any viewer whose path maps
    to the paused frame;
  - right-click on a dot → a PromptDialog to edit condition / hit count /
    log message.

  The current-line highlight is a static background, not animated.
- Keys: F5 continue, F10 over, F11 into, Shift+F11 out, Shift+F5 stop,
  while the panel's session is paused. They are registered through the
  rebindable keymap, not hardcoded.
- All strings go through `useT()`, with keys in `i18n.ts` and the four
  dicts. The pdb tooltips (`fileViewer.debugPdb*`) are reworded for the
  debugpy path and kept for the fallback.
- Tests: the panel renders each state, a toolbar click sends the right
  request, the gutter's verified/unverified/conditional dots, the
  right-click dialog, and the current-line arrow in a second viewer of the
  same file.

### D4 — docs, register, QA (about ½ day)

- Help: `docs/help/` files-and-viewers → "Python run and debug"
  rewritten. A new `docs/context/python_debug.md` holds the mechanism and
  decisions in short form, added to AGENTS.md's context list. Filemap rows
  go in for every new file.
- The `UntestedTag` row `python-debugpy` and the TODO: group-m #87 gets a
  child entry with 🖐️ boxes per platform (local, SSH host, container,
  Python 3.8, and the fallback on Python 3.6).
- `docs/third_party_update_checklist.md`: a debugpy section (bump the
  wheel, `VERSION`, the blob id, check the Python floor).

## Organisation

The default is the **main loop**, step by step, D0 → D4, with gates after
each step. If the user asks for "plan + implement + review with
subagents", use a **mixed-risk chain**: D1 implementer → an independent
reviewer (spawning processes, SSH/Docker argv, exit teardown) → D2 and D3
implementers in sequence (D3 depends on D2's stores) → D4 folded into the
final review's fixes. That is at most 2 agents running at once. Hot shared
files (`i18n.ts`, the filemaps, `command_class`, `untested.ts`) are edited
only in the step that owns them.

## Verification

- Gates: `scripts/gates.sh` per step, and `--all` before landing. Run
  `npm run backend:stale` after D1 and report its result.
- Never run live by the agent. Click-through for the user, on the frozen
  dev build:
  1. Turn on Experimental → Python Run/Debug. In a local project with a
     `__main__` script, set two breakpoints, one of them in an imported
     module that is open in another tab. Press Debug. It should stop at
     the first, show stack and variables, and F5 should reach the second.
  2. In the console, `evaluate` a local variable. Add a watch.
  3. Turn on *Raised* exceptions and run a script that catches an error.
     It should stop at the `raise`.
  4. Set a conditional breakpoint `i == 3` in a loop. It should stop once.
  5. Repeat step 1 on an SSH project (first run stages debugpy), then on a
     container project.
  6. On an interpreter older than 3.8, Debug should open the pdb terminal
     with the notice.

## Risks and open questions

- **SSH without ControlMaster (Windows clients).** Each ssh opens its own
  connection. Behind a round-robin login-node DNS name, the adapter and the
  run tab can land on different nodes, and the launcher then fails to
  connect. Mitigation: on Windows, launch the adapter with the tab's host
  name pinned through `ssh -G`'s resolved `hostname`. If that is not
  enough, refuse with a clear message. D0 should check how often it
  happens.
- **Container restarts** wipe `/tmp` staging. The marker check handles it,
  at the cost of one re-upload of about 5 MB.
- **A program started with `debugpy` in its own code** (`debugpy.listen()`
  in the script). The env's debugpy is shadowed by the bundled one, which
  usually works. Attach mode stays out of scope for v1.
- **Frames in site-packages on a remote host** have no viewer source in v1.
  A later step could read them through SFTP into a read-only viewer.
