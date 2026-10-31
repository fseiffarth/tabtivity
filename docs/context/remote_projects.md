# Remote projects (SSH/SFTP-native, mount-free)

Referenced from `AGENTS.md`.

Remote (SSH) projects are **mount-free** (no sshfs/FUSE): they are SSH/SFTP-
native. Agent/terminal tabs run on the host over `ssh -tt`, file browsing and
file I/O go over SFTP, and git runs on the host over SSH — all riding one
pooled ControlMaster + `Sftp` session per active remote project (opened via
`remote_connect`, see `services::remote`). Such projects carry a `remote` spec
(`user?`, `host`, `port?`, `remote_path`, `openvpn?`) in their `project.json`
and mirrored into the `projects.json` entry's `extra` (the always-local source
of truth `remote_target_for` reads). Their `directory` is a **local** per-
project state dir (`~/.local/share/tabtivity/remote-projects/<id>/`) that holds
`project.json`; the actual tree lives on `host:remote_path`. Remoteness is
resolved explicitly by `services::remote::remote_target_for{,_dir}`, never by a
path convention.

## Remote-only

A remote project created with *Keep a local copy* off has **no local tree at
all**: the file panel and viewers read over SFTP, every tab, run and build runs
on the host, git runs on the host, nothing is synced. Tabtivity keeps only
cockpit state (the registry entry, `project.json`, `sessions/<id>/`, time,
notes). Plan and step-by-step record: `docs/remote_only_projects_plan.md`,
`docs/remote_only_projects_handoff.md`.

- **One posture, VMs included.** A VM project was already mirrorless, but by
  five unrelated signals. The posture now has a name and a VM is *remote-only +
  boot* (`docs/context/vm_projects.md`): one backend predicate
  (`RemoteSpec::is_remote_only()` = `vm == Some(true) || remote_only ==
  Some(true)`; a VM outranks the flag, so a hand-edited `remote_only: false`
  never gives a VM a mirror) and one frontend twin (`isHostPinned`). Everything
  about "no mirror" reads it; VM-only surfaces (boot, egress, the ▣ glyph, mail
  reader) keep reading `vm`.
- **The renderer never sets it.** It asks with the create/import request's
  top-level `remoteOnly`; the backend strips any `remote_only` sent inside
  `req.remote` and writes the field itself. The trusted copy is `projects.json`.
  Workers drop the field on write and on read. Absent = the old behaviour, so
  every existing entry round-trips; an older build reads a remote-only entry as
  a plain Remote with an empty mirror (degraded, no loss).
- **One resolver, refusals at the entry points.** `remote::local_copy_in` /
  `remote_sync::mirror_dir_opt` answer `None` for a remote-only project (and
  for a local, unknown or unreadable one), and the readers that wanted "the
  local tree" for something other than sync use it. The sync engines keep
  `mirror_dir()` and are simply never reached: their entry points refuse with
  the `{UPPER}_REMOTE_ONLY:` sentinel (`remote_only_refusal`), which the cockpit
  maps to one translated line and never shows raw. `connect_host` mints a
  mirror only for a plain Remote primary (`mints_mirror`), which also stopped
  every VM boot from creating an empty one.
- **Nothing of the project runs locally.** With no tree, none of `exec_trust`'s
  subjects can run here; a `local_only` spawn (local-model tabs included) is
  refused, not downgraded. The local attack surface is what crosses SFTP into
  viewers and explicit Download-to writes. Opening a host file in an OS app,
  native drag-out and the SQLite viewer are refused on every host listing (the
  Remote side of a plain Remote too): those paths exist only on the host.
- **Host git is hardened, bounded, and refuses old git.** Making the host the
  only git exposed that lockstep's host arm and the host push ran git bare. All
  host git now goes through the hardened runners (hooks off except the
  trust-gated calls and the push's pre-push hook), under the git verb's local
  ceiling and the host's own `timeout` when it has one. A host git older than
  2.9 ignores `core.hooksPath`, so hooks-off verbs that run hooks are refused
  there (plain Remote projects too): failing closed beats running a repo's
  hooks on a cluster login node.
- **Creation sets up the host folder after an awaited connect.**
  `remote_project_init_host` writes the scaffold over SFTP create-new (never
  over anything there) and commits only at the repo's top level on an unborn
  HEAD, staging only scaffold paths: a browsed folder may already hold the
  user's files or sit inside a home-directory repo. A clone runs `git clone`
  in a visible host tab with the host's credentials; it never calls the init.
- **Search walks the host, never on its own.** `grep`/`find` run in their own
  `sh -c` (the login shell may be fish or csh), every value quoted; a
  disconnected project answers at once without dialing, and an HPC host asks
  per run.
- **Locality is pinned, workers are shared-filesystem only (D4).**
  `worker_sync` sources from the mirror, so a synced-copy worker has nothing to
  receive: it cannot be added or patched on, the tab badge and `+` menu offer
  it disabled, and the phone does not list it. A stored `host:<id>` tab location is kept (it may be
  a shared-fs worker).
- **Down means a Connect placeholder (D5).** No cached tree, no local record
  of host file names.
- **The TeX build is typed into a host login shell**, not run as the tab's
  program: a restored shell tab respawns its command without arguments, which
  would rerun a bare `latexmk` over the project root on every launch.
- **Export and import.** The tree travels only as the host's copy. A bundle
  without a tree imports remote-only (no mirror folder); one with a tree
  imports as a plain Remote whose mirror is that tree.
- **Conversions.** Remote ⇄ Remote-only is the pill's job after creation
  (Local → Remote-only later, as Extend to remote followed by the conversion).
  The mirror folder is never deleted by it (D8), and both directions refuse a
  VM in v1: the VM's mirror must be manual-pull-only, and pairing through
  ordinary lockstep would land agent-written VM bytes here.
