# HPC workspaces in Tabtivity — the layout, and the plan around it

Status: Phases 0, 1 and 2 implemented (untested on a cluster); Phase 3 proposed.
Companion to `docs/quirky-knitting-umbrella` (the SLURM pipeline) and TODO group
G #86.

## The problem

On a SLURM cluster the filesystem is split by *purpose*, and getting it wrong is
expensive in a way nothing in the UI would otherwise mention:

- **home** — small (a per-user quota, commonly ~100 GB), persistent, backed up,
  identical on every node. Meant for code and job scripts. Filling it locks the
  user out of everything, including logging in cleanly.
- **the parallel filesystem** (Lustre/BeeGFS/…) — effectively unlimited space,
  handed out as a **workspace**: a named directory with a *duration* and an
  *expiry*, after which it is **deleted** (sites keep the data a few weeks and
  can restore it, but recovery needs the workspace's **name**). Created with the
  `hpc-workspace` tooling: `ws_allocate <name> <days>`, `ws_list`, `ws_find`,
  `ws_extend`, `ws_release`. Bulk input, output and temporary data belong here.

Tabtivity's remote projects have exactly **one** host root (`RemoteSpec.remote_path`),
from which every transport is derived — SFTP upload, byte-sync, git lockstep, the
file tree, the run tabs. So "where does the project root go" is not a cosmetic
choice: it decides which of the two filesystems everything Tabtivity does lands on.
Before Phase 0 the pipeline browsed to a folder (i.e. `$HOME`) and made that the
root, which pointed every one of those transports at the quota.

## The decision: the project root IS the workspace

```
  the parallel filesystem (expires)              home (persistent, backed up, quota'd)
  /<fs>/<user>-<ws>/                             ~/tabtivity/<project>/
  └── <project>/        ← PROJECT ROOT           ├── logs/          ← #SBATCH --output
      ├── code, job.slurm   (git lockstep)       ├── workspace ->  /<fs>/<user>-<ws>
      └── data/, outputs/   (byte-sync)          └── workspaces.txt  (append-only record)
```

Three reasons, in order of weight:

1. **Every mechanism already works, unchanged.** One root means the walkers, the
   manifest, the lockstep pairing, the big-folder census and the run tabs all
   resolve to the workspace with no new concept. The alternative — project in
   `$HOME` with the workspace symlinked in as `data/` — is *half* working, and
   the wrong half: `sftp::list_dir_on` follow-stats symlinks, so the file tree
   **navigates** into it and opens files, while `remote_sync::walk_host_files` is
   lstat-typed and **skips** it (guard G3), so the mirror never sees a single
   file under it. Visible but unsynced is worse than absent: it reads as covered.
2. **The durable copy of the code is the local mirror + git, not the host tree.**
   Tabtivity already treats the host side as a working copy that lockstep can rebuild.
   So expiry costs a re-pair, not the work — provided outputs were pulled, which
   Phase 2 is about.
3. **Quota safety becomes structural.** Nothing Tabtivity does — sync, upload, job
   output, checkpoints — can fill home, instead of that being a rule the user has
   to remember at every step.

Accepted costs, stated rather than hidden:

- `.git` lives on the parallel filesystem, which dislikes many small files.
  Lockstep transfers are single bundle files, so the traffic is fine; it is
  working-tree checkouts that get slower. Tolerable, and Phase 3 is the escape
  hatch if it ever isn't.
- Expiry deletes the host tree wholesale, repo included. That is a **certainty on
  a ~1 year horizon**, not an edge case — which is precisely why Phase 2 exists.

## The home anchor: what stays behind

A workspace path (`/<fs>/<user>-<ws>`) is unmemorable, and once the workspace is
gone the only thing that can recover it is its **name**, which by then nobody
remembers. So each HPC project keeps a *small* folder in home — nothing that can
grow, and nothing Tabtivity syncs:

| Entry | Why it is there |
|-------|-----------------|
| `logs/` | `#SBATCH --output` points here, so the record of *what was run* outlives the workspace and is backed up. Small by nature — logs only, never artifacts. |
| `workspace` → the workspace path | `cd ~/tabtivity/<project>/workspace` from any login node, and a job script can reach it without hardcoding a site path. Goes dangling at expiry, which is itself a signal. |
| `workspaces.txt` | Append-only: date, workspace id, filesystem, path, requested duration, the project name, and the **local mirror path** (which machine holds the durable copy). This is the file that makes `ws_restore` possible, and the one that answers "which workspace held the Q3 runs?" a year later. |

The anchor is *host-side navigation and provenance*. It is deliberately outside
the project root, so no walker, manifest or census ever touches it.

## Phases

### Phase 0 — the workspace step (implemented)

- `commands::hpc_ws`: `hpc_ws_available` / `_list` / `_allocate` / `_extend` /
  `_release` / `_link`. Reuses `commands::slurm`'s dispatch for a project target
  and adds a bare-host target (`run_ssh_auth`) because a workspace is allocated
  **before** the project exists. Site-agnostic (`ws_list -l` is asked, nothing is
  preset); every interpolated value validated *and* `shell_quote`d; list/allocate
  each append a `ws_find` confirmation in the same round trip, because the *path*
  is what everything downstream depends on and `ws_list` layouts differ by version.
- `lib/remote/hpc/hpcWorkspace.ts` + a **Workspace** step in `HpcPipelineWizard`, between
  Project and Load data, which is now the step that calls `create_project` —
  because it is what decides the remote root. The integration is one assignment:
  `remoteChosenPath = <workspace path>`.
- The Jobs view lists the project's workspaces with days-left (toned) and Extend.

### Phase 1 — the home anchor (implemented)

1. `hpc_ws_anchor(target, anchor_rel, workspace, project_name, mirror_path)` —
   one `sh` script: `mkdir -p $HOME/<rel>{,/logs}`, `ln -sfn <ws> …/workspace`
   (refusing to replace a real file), append the record, print the resolved
   absolute paths. Everything quoted; `anchor_rel` validated as a path-safe
   segment list so it cannot escape `$HOME`.
2. Persist it on the project: an additive optional `hpc` block in `project.json`
   (`workspace_id`, `workspace_path`, `filesystem`, `anchor_dir`, `logs_dir`),
   mirrored into the `projects.json` entry's `extra` like `run_host` is. Nothing
   else can be re-derived after the workspace is gone.
3. Wizard: a checkbox in the Workspace step (default on when a workspace was
   chosen), with the anchor path shown and editable (`tabtivity/<project>`).
4. Wire the logs: the starter script's `--output` becomes
   `<logs_dir>/slurm-%j.out` (a `spliceDirective` call, so it stays an ordinary
   edit), and `slurm_job_out`'s fallback for a job `scontrol` has forgotten
   prefers the recorded `logs_dir` over its `<WorkDir>/slurm-<id>.out` guess —
   otherwise "Watch" on an old job silently tails nothing.

Two details the implementation pinned down that the sketch above did not:

- The anchor is recorded **both** absolutely (`anchor_dir`) and as the
  `$HOME`-relative path it was created from (`anchor_rel`). Re-anchoring after a
  move must pass the *rel* back, and deriving it by chopping segments off the
  absolute path guesses wrong for any folder that isn't two segments deep.
- `validate_anchor_rel` rejects `.`/`..` segments explicitly: `validate_token`
  permits `.` inside a name (`my.project`), so traversal had to be its own rule.

### Phase 2 — surviving expiry (implemented)

5. **Re-point the root.** There is no way today to change a primary's
   `remote_path` after creation (`RemoteMachinesWindow`'s path field only adds
   worker machines). Add "Move to another workspace…": allocate or pick, set the
   new root, re-pair the mirror (lockstep seeds it from the local side, which is
   the durable copy), re-link the anchor and append the record. Without this,
   expiry means re-creating the project by hand — on a horizon of months, for
   every HPC project.
6. **Say the clock out loud.** The persisted `workspace_id` makes a cheap
   days-left read possible on connect; warn on the pill and in the Jobs view at
   ≤7 days, urgently at ≤2, with **Extend** and **Pull everything down** right
   there. The wizard already registers the site's own `-r`/`-m` reminder mail;
   this is the in-app twin, and it is the only thing standing between a busy
   month and a deleted campaign.
7. **Pull the logs down** (small, optional): copy the anchor's `logs/` into the
   local mirror on demand, so the provenance record exists on the laptop too.

As built: `hpc_ws_move_root` + a **Move here** action on every non-current
workspace row in the Jobs view; the confirm states plainly that the new root
starts empty, is re-seeded from the local mirror, and that anything living only
in the old workspace stays behind. The caller disconnects around the rewrite (the
pool caches the spec) and **reconnects before re-anchoring**, since the anchor
script rides the project's own SSH path. The expiry banner (`shouldWarnExpiry`,
≤7 days / ≤2 urgent) is raised in *every* view of the project, not just Jobs,
carries Extend + Workspaces, and is dismissible only until the number changes.
`hpc_ws_pull_logs` is the **Pull logs** button beside the workspaces caption.

### Phase 3 — only if the split layout is ever wanted

8. **Map a prefix instead of following a link.** Register `data` → an absolute
   host path in the sync manifest and resolve it in `join_remote`, so walk, push,
   pull, stat and mkdir all address the workspace directly with no symlink in the
   path. This is the principled version of "project in `$HOME`, data in the
   workspace" — it needs no relaxation of G3 (nothing is followed; a registered
   mapping is consulted), but it threads a mapping through `join_remote`'s call
   sites, so it is a day of careful work in the sync core plus tests. Worth doing
   only if putting `.git` on the parallel filesystem turns out to hurt.

## Portability: what this assumes about a cluster

Nothing about any *particular* cluster. The only site values that appear anywhere
in the feature are inside **test fixtures** (captured sample tooling output); no
filesystem name, path, hostname or day limit exists in the logic. Concretely, the
whole thing rests on two *families* and degrades cleanly outside both:

| Layer | Assumed | If absent |
|-------|---------|-----------|
| Scheduler | SLURM (`sbatch`/`squeue`/`scancel`/`scontrol`/`srun`) | `slurm_available` is false → the SLURM bar and the Jobs view hide themselves. PBS/LSF/SGE would be a separate backend, not a change here. |
| Storage | `hpc-workspace` (`ws_allocate`/`ws_list`/`ws_find`/`ws_extend`/`ws_release`) | `hpc_ws_available` is false → the Workspace step falls through to **site-filesystem candidates** (below). |
| Shell | POSIX `sh` + `mkdir`/`ln`/`date`/`df`/`awk` | These are not optional on a cluster login node. |

Everything variable is *asked*, never assumed:

- **Which filesystems exist** → `ws_list -l` (including which is the default).
- **How long a workspace may live** → the site caps `ws_allocate`'s duration and
  its refusal is surfaced verbatim; Tabtivity only bounds the input to 1–3650 days
  so a typo cannot ask for a millennium.
- **Where a workspace actually is** → `ws_find`, never a path pattern.
- **What `ws_list` output looks like** → parsed by keyword, with the `ws_find`
  map as the authority for the one field that matters, so version differences
  (`available` vs `remaining extensions`, `Id:` blocks or not) do not break it.
- **Whether `ws_extend` exists** → falls back to `ws_allocate -x` (older tooling).

**Clusters with SLURM but no workspace tooling** — the many sites that instead
export `$SCRATCH`/`$WORK`/`$PROJECT` or follow a `/scratch/$USER` convention —
are covered by `hpc_scratch_candidates`: the Workspace step asks the host which
of those the *site's own profile* exports, reports each with its writability and
free space, and offers them as the project root beside "home". Without it, such a
project would land in the browsed folder — i.e. `$HOME` — which is the exact
failure this whole step exists to prevent. The variable *names* probed are the one
site-shaped list in the module, and they are only names to ask about; the host
decides which mean anything.

## What is deliberately not done

- **No site presets.** No cluster hostname, filesystem name or day limit is
  hardcoded anywhere; the host is asked (`ws_list -l`, `ws_list`) and its own
  output is parsed. A site that caps 90 days at 30 simply answers 30.
- **No automatic pull of a workspace.** A workspace can hold terabytes; byte-sync
  stays opt-in per path (the manifest) and the big-folder census still prices a
  subtree before it is marked. Making the workspace the root does not change that.
- **No second host root.** The anchor is not a second project tree — it holds
  logs, a link and a text file, none of which Tabtivity syncs, so no walker, manifest
  or census needs to learn about two roots.
