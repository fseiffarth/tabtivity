# Multi-host remote (compute hosts)

Referenced from `AGENTS.md`.

- **A remote project can reach N machines, not one** (`services::worker_sync`). The project's `remote` is the **primary** — it still owns
  files, git, the mirror, and full bidirectional sync, unchanged. Extra **worker**
  hosts (`Project.compute_hosts`, mirrored into `projects.json`'s
  `extra["compute_hosts"]`) are experiment machines: their code is kept **one-way** in
  sync from the mirror (source→worker, tracked files only, `reset --hard`, **never
  `git clean`**), their files are read-only, and their experiment **outputs** (untracked
  paths) stay on the worker until a user-initiated, size-confirmed **Pull outputs** — the
  only worker→local byte path. Because worker sync is push-only it dodges the entire
  divergence/conflict/local-loss half of lockstep. Each host has its own pool entry
  (`remote::conn_key`, keyed `(project, host)`), its own pill lamp, and its own tab
  locality (`host:<id>`); the primary is the implicit `"primary"` id, so every existing
  file/git/sync caller keeps meaning "the primary" with no change. A tab runs on a host
  via its `host:<id>` location → `PtyOptions.remote_host_id`. Managed from the pill's
  "Remote machines…" (`RemoteMachinesWindow`).
  - **A worker can instead SHARE the primary's folder over a shared filesystem — and
    this is now the DEFAULT for a newly added machine** (`ComputeHost.shared_fs`,
    schema default `false` for back-compat but the "Add machine" form ticks it on;
    untick "Sync a copy" ⇒ shared). A shared-fs worker sees the primary's project
    folder at its own `remote_path` (an HPC compute node on a shared home), so Tabtivity
    copies **nothing** and **never runs git on it** — a tab just `cd`s into that folder
    and runs there (`wrap_pty_options` already uses `spec.remote_path`, so tab spawn is
    unchanged). This is load-bearing for safety: the code path that would `git init` +
    `reset --hard` a synced worker's tree must **never** fire on a shared-fs host, or it
    corrupts the primary's real working tree. Three guards enforce it — `remote_connect`
    skips `on_worker_connect`, `worker_sync::fan_out` skips via `wants_code_fanout`
    (`!shared_fs && sync_code`), and `sync_worker` itself early-returns a no-op skip for a
    shared-fs host so even a stray `worker_sync_now` is harmless. "Sync code now" / "Pull
    outputs" / "Auto-sync code" are hidden for a shared-fs worker (its outputs are already
    in the primary's folder, moved by the primary's own sync).
  - Commit-triggered fan-out and the manual **Sync code now** action enter the
    same `(project, host)` in-flight guard. Only one writer may build, upload,
    and apply that worker's fixed bundle path at a time; a racing second action
    reports a harmless skip.
