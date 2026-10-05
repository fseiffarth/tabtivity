# Tabtivity — Code Review

Date: 2026-06-18
Scope: full `src/` (React/TS) and `src-tauri/src/` (Rust) tree.
Reviewer: automated deep review (bugs, runtime performance, duplication,
backend integration, security). No code was changed; this document records
findings and recommendations only.

Overall the codebase is in good shape: command surface is well factored, path
confinement is generally enforced, there is broad unit-test coverage, and the
crash-reporting / webview-recovery work is solid. The findings below are ordered
by severity within each category. Line references are accurate as of this commit
(`43e2ef7`).

---

## 1. Bugs / correctness

### 1.1 `clear_project_session` command does not exist (broken debug action) — High
`src/components/layout/RightPanel.tsx:493` invokes `clear_project_session`, but
that command is **not** registered in `src-tauri/src/lib.rs`'s
`invoke_handler!` list and is not defined anywhere in the backend
(`grep` finds only the frontend call site). The button is gated behind
`settings.debug`, so the failure is hidden in normal use, but in debug mode the
"Clear session storage" button rejects with "command not found", the
`.catch(console.error)` swallows it, and the intended `window.location.reload()`
never runs — the action silently does nothing.
Fix: either implement and register the command, or remove the button.

### 1.2 Path-traversal escape when intermediate directories don't exist — High (security + correctness)
`enforce_confinement` (`src-tauri/src/commands/projects.rs:874`) is a purely
**lexical** `target.starts_with(root)` check. For the read/delete commands
(`list_dir`, `delete_file`, `delete_dir`) the target is fully canonicalized
first, so `..` is resolved and the check is sound. But the *write* commands —
`create_file:267`, `write_project_file:283`, `write_project_file_bytes:301`,
`create_dir:361` — canonicalize via `canonical_or_new` (`:861`), which only
canonicalizes the **parent**. When an intermediate path component does not yet
exist, `canonical_or_new` cannot canonicalize the parent and returns the path
**unchanged**, leaving `..` components unresolved. `starts_with` then matches
lexically (`/root/missing/../../escape` "starts with" `/root`), confinement
passes, and `fs::create_dir_all(parent)` happily resolves the `..` and writes
**outside the project root**.

The existing test `write_project_file_blocks_parent_escape` only covers
`../outside.md`, whose parent (the project root) *does* exist and therefore
canonicalizes — so the gap is untested. Note `update_gitignore_rule:317` is the
only write path that calls `normalize_project_rel_path` (`:776`, which rejects
`..`/root components); the other four writers should do the same.
Fix: run all write targets through `normalize_project_rel_path` (or a
lexical-normalization step that collapses/rejects `..`) **before**
`canonical_or_new`.

### 1.3 `import_project` "move" mode fails across filesystems — Medium
`src-tauri/src/commands/projects.rs:580` uses `fs::rename(&source, &dest)`. When
the source folder and `~/tabtivity/projects/` live on different mounts (very common:
`/home` vs an external/`/mnt` checkout) `rename` returns `EXDEV` and the import
fails outright. `copy` mode already has a working `copy_dir_all`.
Fix: on `rename` error fall back to `copy_dir_all` + `remove_dir_all(source)`.

### 1.4 `uuid_v4()` is neither random nor collision-safe — Medium
`src-tauri/src/commands/projects.rs:885` derives every UUID group from a single
`SystemTime` nanosecond reading and formats it into a UUID-shaped string. Two
projects created within the same nanosecond tick (e.g. scripted/batch import) get
the **same** id, and the value is fully predictable. Project ids are used as map
keys and persisted relationships, so a collision corrupts state. The crate
already isn't dependency-shy elsewhere.
Fix: use the `uuid` crate (`Uuid::new_v4()`), or at minimum mix in a random
component and a per-process counter.

### 1.5 `flush_secs` snapshot path in `switch()` is dead — Low
`src/stores/projects.ts:128` always sends `flushSecs: 0.0` in the switch
snapshot, so the `if snapshot.flush_secs > 0.0` branch in
`services/project_runtime.rs:65` never runs. Time flushing is instead done
entirely by `useTimerStore.setProject`. The backend branch and the
`flush_project_secs` helper (`project_runtime.rs:239`) are effectively unused.
Not a bug today, but it is a latent double-count risk if a future change starts
populating `flushSecs` without removing the timer-store path. Pick one owner of
time-flush-on-switch and delete the other.

### 1.6 `check_pid_alive` is fooled by PID reuse (Linux) — Low
`commands/apps.rs:697` only checks that `/proc/{pid}` exists. After the original
app exits and the OS recycles its PID, a tracked window can appear "alive"
indefinitely. Acceptable for a coarse UI hint, but worth a comment; combining
with the recorded `exec`/start-time would harden it.

---

## 2. Runtime / performance

### 2.1 Blocking network I/O inside `async` Ollama commands — High
`commands/ollama.rs` declares its commands `async fn`
(`list_ollama_models_detailed:102`, `pull_ollama_model:156`,
`stop_ollama_model:147`, `delete_ollama_model:178`, `list_ollama_models:458`,
`ensure_ollama_running:384`) but performs **synchronous** blocking I/O:
`ollama_http` (`:40`) opens a `std::net::TcpStream` with a **600-second** read
timeout and `read_to_string`, and `ensure_ollama_running` uses
`std::thread::sleep` + blocking `Command::status()`. Because these run on the
Tauri/Tokio async runtime, a slow or hung Ollama call can pin a runtime worker
thread for up to 10 minutes, starving other async commands (notably
`pty_*` and `project_cpu_percent`).
Fix: make these plain `fn` commands (Tauri runs sync commands on its own thread
pool) or wrap the blocking work in `tokio::task::spawn_blocking`.

### 2.2 `time_log.json` grows unbounded with O(n) rewrites — Medium
Time is flushed every 60s (`AppShell.tsx:69`) and on every project switch. Each
flush (`commands/timer.rs:45`, mirrored in `project_runtime.rs:239`) reads the
**entire** log, appends one `TimeLogEntry`, and rewrites the whole file. A normal
workday adds hundreds of rows; over months the file reaches thousands of entries,
and every 60s flush re-serializes all of them. Readers (`get_time_today`,
`get_project_activity`) also scan the whole vector.
Fix: aggregate per `(project_id, date)` on flush (update the day's row instead of
appending), or compact on startup. This also speeds up the activity calendar.

### 2.3 `git_file_statuses` is heavy and called redundantly — Medium
`commands/git.rs:153` shells out to `git status --porcelain --ignored` **and**
`git log @{u}..` on every call. It is invoked on every file-tree navigation
(`FileTree.tsx:158`) *and* again for the root by `RightPanel.refreshGit`
(`:93`) on every panel open. On large repos this is noticeably slow, and the two
call sites duplicate the same root-level query when the panel opens.
Fix: compute statuses once per refresh and reuse; debounce navigation; consider
caching keyed by repo HEAD/index mtime.

### 2.4 Per-terminal global event listeners scale O(N) per output chunk — Low
Each `TerminalView` registers its own global `terminal-output` listener
(`TerminalView.tsx:120`) that filters by `id`, plus AppShell has a global one
(`AppShell.tsx:90`). With N open terminals, every batched output event fans out
to N+1 JS callbacks, each doing a string compare, even though only one matches.
Fix: a single multiplexing listener that dispatches by id to a registry of
write callbacks.

### 2.5 Sequential blocking window probing on app restore — Low
`do_launch` (`commands/apps.rs:72`) calls `find_window_for_pid` (`:810`), which
polls X11 up to 20×100ms = 2s. `restore_open_apps` (`:727`) launches apps in a
**sequential loop**, so restoring K apps blocks the calling thread up to K×2s.
Fix: launch concurrently, or reduce the probe budget for restore.

---

## 3. Duplicated code

### 3.1 Projects-list read/modify/write boilerplate — Medium
The "load `projects.json` (or default), mutate, `write_json`" sequence is
repeated in `create_project` (`projects.rs:512`), `import_project` (`:591`),
`save_projects` (`:27`), and `set_project_description` (`:43`). Extract a small
helper (`load_projects_list()` / `with_projects_list(|list| …)`) to centralize
the path, default, and error handling. This is also where the TOCTOU race lives
(see 4.4).

### 3.2 Two near-identical `flush_secs` implementations — Low
`commands/timer.rs:45` and `services/project_runtime.rs:239` are essentially the
same "append a `TimeLogEntry` to time_log.json" function. With 2.2's aggregation
fix, collapse them into one shared helper (e.g. in `timer.rs` or `storage`).

### 3.3 Duplicate `iso_now` with divergent formats — Low
`storage::iso_now` (`storage.rs:75`) emits `+00:00`; `lib.rs::iso_now`
(`lib.rs:59`) emits `Z`. Two timestamp formats are now written to different files
for the same concept. Consolidate on one (`storage::iso_now`) and have crash-log
call it, or document why the suffix differs deliberately.

### 3.4 Name sanitization duplicated across Rust and TS — Low
`sanitize_name` (`projects.rs:709`) and `sanitizeName` (`ProjectSwitcher.tsx:51`)
implement the same rule. The frontend computes `targetDir` from its copy
(`ProjectSwitcher.tsx:868`) while the backend re-derives the directory in move/copy
import from its own. If the two ever diverge the destination shown to the user
won't match what the backend creates. Treat the backend as source of truth and
have the frontend display the backend-returned path, or share the rule.

### 3.5 Two byte formatters — Low
`fmtBytes` (`ProjectSwitcher.tsx:619`) and `fmtSize` (`components/files/fileUtils.ts`)
both format byte counts. Minor; unify if convenient.

---

## 4. Backend integration / reliability

### 4.1 JSON state writes are not atomic — Medium
`storage::write_json` (`storage.rs:16`) writes directly to the destination file.
A crash or power loss mid-write (and this app has a documented history of webview
crashes — see `MEMORY.md`) truncates `projects.json` / `time_log.json` /
`settings.json`, losing all state. Readers then fall back to `unwrap_or_default`,
silently discarding the user's projects.
Fix: write to a temp file in the same directory and `fs::rename` over the target
(atomic on POSIX). Optionally keep a `.bak` of the previous good copy.

### 4.2 `git_token` stored in plaintext and unused — Medium (security)
`schema/settings.rs:31` persists `git_token` to `settings.json` in plaintext, and
the Settings UI captures it (`ProjectSwitcher.tsx:328`/`348`). But `grep` shows the
token is **never** sent to any git command — it is dead aside from being a
plaintext secret on disk. Either remove the field, or, if a feature is intended,
store it in the OS keyring (e.g. `keyring` crate / `tauri-plugin-stronghold`)
rather than a world-readable JSON file. (Note `.gitignore` covers `.tabtivity/` but
`settings.json` lives in `~/.local/share/tabtivity/`, so it's not committed — the
risk is local disk/backup exposure.)

### 4.3 `detect_mime` reads arbitrary absolute paths — Low (security)
`commands/projects.rs:371` opens and reads the first 8KB of **any** path the
caller passes, with no project confinement. The frontend is trusted, so this is
low risk today, but it is an unconstrained file-read primitive: any future
webview XSS / malicious content-injection gains an arbitrary-file disclosure gadget.
Fix: confine to a project root like the other file commands, or document the
intentional global scope.

### 4.4 Read-modify-write races on shared JSON — Low
All `projects.json` / `time_log.json` mutations are unsynchronized
read-modify-write cycles. For the normal single-window app this is fine, but two
near-simultaneous commands (e.g. a project switch flushing time while a
description edit saves the list) can lose one write. A process-wide `Mutex`
around each state file (or the helper from 3.1) would remove the race; atomic
writes (4.1) reduce the blast radius.

### 4.5 `ollama_http` HTTP parsing is fragile — Low
`commands/ollama.rs:40` hand-rolls HTTP/1.0, assumes the body is valid UTF-8
(`read_to_string`), splits on the first `\r\n\r\n`, and ignores `Content-Length`.
It works against the local Ollama daemon but will break on any non-UTF-8 body or
unexpected framing. Acceptable for a localhost-only client; worth a comment, or
use a minimal HTTP client crate.

---

## 5. Minor notes / nits

- `commands/apps.rs:113` `registry.lock().unwrap()` (and many others) will
  poison-panic if any thread panics while holding the lock. Given the crash
  handlers, consider `lock().unwrap_or_else(|e| e.into_inner())` for the
  registries that must survive a panicked sibling.
- `terminal/mod.rs:207` silently drops PTY output chunks when the channel is full
  (`tx.try_send`). This is the documented backpressure design, but under a flood
  the terminal will show gaps with no indication; a one-time "[output truncated]"
  marker would aid debugging.
- `MIN_RESTART_INTERVAL` (`terminal/mod.rs:27`) is `#[allow(dead_code)]` — either
  wire it into the crash-loop guard or remove it.
- `deactivateProject` (`stores/projects.ts:162`) falls back to `nextProjects[0]`
  when no `"active"` project exists, which can be the just-deactivated project;
  confirm the intended next-active selection.
- `TerminalView` re-creates the terminal whenever `cwd`/`cmd` change
  (`TerminalView.tsx:206`), discarding scrollback. Confirm this is intended for
  in-place project moves.

---

## Suggested priority order

1. 1.2 path-traversal on write commands (security)
2. 1.1 broken `clear_project_session` (or remove it)
3. 2.1 blocking I/O in async Ollama commands
4. 4.1 atomic JSON writes
5. 2.2 time_log growth/aggregation
6. 1.3 cross-filesystem import move; 1.4 real UUIDs
7. 4.2 git_token handling
8. Remaining performance (2.3–2.5) and duplication (3.x) cleanups
