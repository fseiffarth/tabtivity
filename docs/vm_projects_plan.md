# VM Projects — Isolated Agent VMs over SSH (Implementation Plan)

Status: **implemented, not live-tested** (2026-08-07): Phases 0–4 plus the
mirrorless sync posture are on `develop` (see `todo/group-g-remote.md` G.26
for the item-level ledger and what remains — the opt-in-mirror/manual-pull
half of Phase 5, and Phase 6). Design rationale live-doc:
`docs/context/vm_projects.md`. Nothing below has run against a real VM yet;
the Phase 1/2 live-QA loops are still owed.

## Goal

A third trust tier for projects, above the Docker container toggle: the whole
project — files, shells, agent tabs, builds, test runs — lives inside a locally
booted virtual machine, and Tabtivity talks to it **exclusively over SSH/SFTP**,
exactly as it talks to any remote host. **Remote-only by default**: no host-side
copy of the tree exists at all; browsing, viewing and diffing happen over SFTP
(sub-ms on localhost). A git-lockstep mirror is the same per-project **opt-in**
it already is for any remote project — and when enabled, nothing the agent
writes lands in it except through the existing, confirmed sync paths.

The tier ladder this creates:

| Tier | Boundary | Files | For |
|------|----------|-------|-----|
| Local | none | host | your own trusted work |
| Container (#38) | shared-kernel Docker, bind-mount at identical path | host | semi-trusted; frictionless hygiene |
| **VM (this plan)** | hardware virtualization (KVM), no shared filesystem | **inside the VM** | untrusted repos, full-auto agents |

## The one architectural decision (everything follows from it)

**A VM project IS a remote project.** Not a sibling stack. The VM boots, exposes
SSH on a forwarded localhost port, and from that moment Tabtivity sees an ordinary
`RemoteSpec { host: "127.0.0.1", port: <forwarded>, remote_path, key_auth: true }`.
Every existing mechanism then applies verbatim, already tested:

- pooled ControlMaster + SFTP session (`services::remote`, `remote_connect`,
  `conn_key`) — file tree, viewers, file I/O;
- tabs over `ssh -tt` (`PtyOptions.remote_host_id` path), tmux-backed shell
  survival, agent tabs with resume — the agent's transcripts live *inside* the
  VM, which is the point;
- **optionally, git lockstep** (`services::git_peer`, bundles over SFTP) if the
  user opts into a local mirror — then the mirror is the sole reviewed choke
  point through which agent-written code reaches the host; byte-sync
  (`services::sync_auto`), sync confirm dialogs, local-loss warnings all apply
  unchanged. Default is no mirror (see "Sync posture");
- the three auto-connect gates, lamp/pill UI, `RemoteConnectDialog` — unchanged
  (localhost passes `mayAutoTouch`; a VM host is never HPC-tagged).

This mirrors the lesson written into `docs/context/docker_containers.md` ("there is
exactly one such feature"): the new code is a **VM lifecycle service** plus a
thin creation/activation shim; the trust boundary itself is machinery that
already exists and already asks before it destroys anything.

**Corollary (the actual security property):** the VM gets **no host mounts, no
shared filesystem, no virtiofs/9p** — deliberately. The only channels in or out
are the SSH session and lockstep/byte-sync transfers. This differs from the
container tier on purpose: the container's bind-mount is what makes it a
cheap toggle; its absence is what makes the VM a boundary. Consequently a VM
project is chosen **at creation** (or by an explicit convert, a data move) and
is not a flip-anytime toggle.

Also deliberately absent: the container tier's `~/.claude/projects` transcript
mount. The agent inside the VM has its own home, its own auth, its own
history. Reading other projects' transcripts from inside the boundary would
be an exfiltration channel.

## Backend: `services::vm`

New service owning VM lifecycle, modeled on `services::sandbox`'s shape
(preflight → ensure-running → teardown → startup sweep).

### Runtime: QEMU/KVM, no libvirt

Direct `qemu-system-x86_64 -enable-kvm` invocation. No libvirt daemon
dependency, no root, no bridge networking:

- **Networking = user-mode slirp** with `hostfwd=tcp:127.0.0.1:<port>-:22`.
  Unprivileged, host-firewall-invisible, and the egress story (below) hangs
  off it.
- **Disk = qcow2 overlay per project** backed by a shared base image:
  `qemu-img create -f qcow2 -b base.qcow2 -F qcow2 <state>/vm/<id>/disk.qcow2`.
  Cheap creation, copy-on-write, delete-with-project.
- **First boot config = cloud-init NoCloud seed ISO** generated per project
  (user account, the per-VM public key, hostname, proxy env). Standard Ubuntu
  cloud images consume it out of the box.
- `-daemonize` + pidfile + QMP socket in the VM state dir for clean shutdown
  (`system_powerdown`, escalate to kill after grace) and the startup sweep.

Doctor probe (`vm_doctor` command, surfaced in the creation dialog like the
sandbox's docker preflight): qemu binary present, `/dev/kvm` accessible
(user in `kvm` group), `qemu-img`, `genisoimage`/`cloud-localds`, disk space.
Fail with actionable text; the tier is simply unavailable (greyed, with the
reason) when the probe fails. Linux-only initially; since 2026-09-03 the probe
and boot have macOS (Hypervisor.framework, arm64 guests on Apple silicon) and
Windows (WHPX, TCP QMP, no `-daemonize`) arms, and the seed ISO is written
in-process (`services::iso9660`) where no mkisofs-class tool exists.

### State layout

```
~/.local/share/tabtivity/vm/
  images/tabtivity-base-<ver>.qcow2      # shared base image
  <project-id>/
    disk.qcow2                        # per-project overlay
    seed.iso                          # cloud-init NoCloud seed
    id_ed25519, id_ed25519.pub        # per-VM generated keypair
    known_hosts                       # per-VM host key (see below)
    qemu.pid, qmp.sock, vm.json       # runtime state + spec (mem/cpus/port/egress)
```

Per-VM `UserKnownHostsFile` + `StrictHostKeyChecking=accept-new` on every ssh
argv for this host: a recreated VM has a new host key, and the user's real
`~/.ssh/known_hosts` must never collect or conflict on `[127.0.0.1]:<port>`
entries. We booted the VM ourselves; the host-key-confirmation flow from
`remote_credentials` is bypassed for this connection *only* (the spec carries
a `vm: true` marker to authorize that).

Port allocation: pick a free ephemeral port at boot, record it in `vm.json`,
and rewrite the project's `RemoteSpec.port` (in `projects.json` `extra`, the
always-local truth `remote_target_for` reads) before connecting. Ports are
not stable across boots and nothing should assume they are.

### Base image

Two-stage, to keep first-project latency sane:

1. **Fetch**: download a stock Ubuntu LTS cloud image (qcow2) once into
   `images/`, checksum-verified. This alone yields a bootable VM with sshd.
2. **Bake** (`vm_build_base`): boot it once headless with a provisioning
   cloud-init that installs the agent toolchain — git, build-essential,
   node/npm, the Claude/Gemini/Codex CLIs, tmux — then `system_powerdown` and
   keep the result as `tabtivity-base-<ver>.qcow2`. Surfaced as a **build tab**
   streaming progress, same UX as the sandbox's missing-image build. Re-bake
   on demand ("Update VM base image" in settings), never automatically.

Per-project provisioning stays minimal (user + key + hostname via seed ISO);
everything heavy lives in the baked base so a new VM project boots in seconds.

### Lifecycle binding

Same session semantics as the project container, translated:

- **Boot on activation / on connect**: activating a VM project (or clicking
  its lamp) runs ensure-booted → wait for SSH readiness (bounded poll against
  the forwarded port) → `remote_connect` as usual. With `auto_connect` armed
  this is the existing unattended path; gate (3) (eligibility) is always
  satisfied — `key_auth` by construction, no password ever involved.
- **Shutdown on deactivate** *unless tabs are live in it* (the container
  rule verbatim), on app exit, and a **startup sweep** reaps orphaned QEMUs
  by pidfile — mirroring the sandbox sweep. Optionally "keep running in
  background" per project later; not in v1.
- **Delete project** → confirm → teardown + delete overlay/state dir. The
  dialog states what survives: the mirror if one was opted into, otherwise
  only what was pushed to a git remote — a mirrorless VM project's overlay
  **is** the working tree, and the confirm must say so by name.

### Schema

```rust
// project.json / projects.json extra — alongside `remote`
pub struct VmSpec {
    pub enabled: bool,
    pub memory_mb: u32,        // default 4096
    pub cpus: u32,             // default 2
    pub disk_gb: u32,          // overlay virtual size, default 32
    pub egress: VmEgress,      // Off | Proxy | Open  (default Proxy)
}
```

`RemoteSpec` itself gains nothing except being *written by* the VM service
(host/port/key_auth). `remote_target_for` and every consumer stay ignorant of
VMs — the `vm` block's presence is what activation checks to decide "boot
first". One new invariant: a project with `vm.enabled` must never also enable
the Docker sandbox (`set_project_sandbox` refuses; the tiers are exclusive).

## Egress policy (the honest part)

A truly no-egress VM cannot run a cloud agent — the agent must reach its model
API. Pretending otherwise would be security theater, so the knob is explicit,
three-valued:

- **Off**: slirp `restrict=on`. Guest reaches nothing, including the host.
  Only useful with a local model or for pure build/test isolation. Agent tabs
  are marked unavailable with the reason.
- **Proxy** (default): slirp `restrict=on` **plus** a `guestfwd` channel to a
  host-side allowlisting HTTP CONNECT proxy (small Rust task inside Tabtivity,
  bound to localhost). Cloud-init sets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
  in the guest. Allowlist defaults to the agent API endpoints
  (`api.anthropic.com` etc.) + `github.com` (opt-in per project, off for
  "untrusted import" — cloning happens once, at creation, through a temporary
  allow). Denied CONNECTs are logged and surfaced in the pill ("VM blocked
  N connections"), which doubles as an exfiltration tripwire.
  Caveat stated in the UI: the agent can still exfiltrate *to the allowed
  endpoints* (e.g. inside a model prompt). Proxy narrows the channel; it
  cannot close it while a cloud agent runs.
- **Open**: slirp default NAT. For when the work itself needs the network
  (package installs, integration tests). One click back to Proxy.

Agent auth inside the VM: **no host credential is copied silently.** First
agent tab in a fresh VM runs the CLI's own login flow interactively (device
code flows work fine in a terminal over ssh). Offering an opt-in "inject API
key" convenience can come later; default is the agent inside the boundary
holds only what the user typed into it.

## Creation & UI

- **`ProjectDialog`**: the existing container row becomes a three-way trust
  choice — Local / Container / VM — with the import heuristic extended:
  import/clone of unknown code recommends **VM** when the doctor probe passes
  (falls back to recommending Container as today). Creating a VM project:
  local state dir only (as any remote project), boot VM, and for a clone URL
  run the clone **inside the VM** (temporary allow for the git host through
  the proxy). The untrusted bytes never land on the host at all unless the
  user later opts into a mirror — and then their first appearance is a
  reviewable git history seeded by lockstep.
- **Pill**: the standard remote connection lamp (it *is* a remote project)
  plus a small VM state glyph (booting/running/off). "VM settings…" menu:
  memory/cpus/egress mode/allowlist, Rebuild VM (recreate overlay from base —
  confirm: in-VM uncommitted work dies; the mirror survives), blocked-
  connections log.
- **UntestedTag** on all of it until live-verified, per standing convention.

## Sync posture for the untrusted tier

**These defaults are the inverse of a network remote's, deliberately and VM-
only.** A normal SSH remote project ships with a paired mirror, lockstep ON at
creation, and agents defaulting to the *local* copy — right for WAN latency,
offline work, and login nodes agents shouldn't run on. A VM project flips all
three, because each rationale inverts: latency is nil on localhost, the VM is
always reachable when booted, and agents running local is precisely the escape
the tier forbids. Concretely, the VM creation path must **not** inherit
`create_project`'s remote defaults: lockstep is not armed (no mirror exists),
and tab locality is pinned to the VM host — the silent remote→local fallback
that exists elsewhere in tab spawning must be a **hard refusal** here ("VM not
booted", with a boot action), never a downgrade to a host shell. A downgrade
elsewhere is a perf surprise; here it is the untrusted agent stepping outside
the boundary. (Phase 2 gets a test for exactly this.)

**Default: no mirror.** A VM project is remote-only — the tree exists solely
inside the VM, browsed and diffed over SFTP, which on localhost costs nothing.
This is the most contained posture (zero agent-written bytes on the host) and
the simplest (no sync semantics at all). Its exit path for work is `git push`
from inside the VM to a real remote through the egress allowlist — the UI
should say plainly that without a mirror or a push, the overlay is the only
copy (surface "unpushed commits" in the pill, same spirit as the sync lamps).

**Getting data out** (every channel user-initiated; the agent can stage bytes
but a human clicks every crossing):

1. `git push` from inside the VM to the user's real remote through the egress
   allowlist — the primary exit; never touches the host.
2. The opt-in mirror's confirmed pulls (below) — commits via lockstep,
   artifacts via the explicit size-confirmed byte transfers.
3. **"Download to…"** — per-file/folder SFTP copy to a host path chosen in a
   dialog, size-confirmed. This must be **built** (Phase 2): the existing
   file-tree transfer buttons all assume a mirror as the destination, so the
   mirrorless default otherwise has no casual per-file exit. (Viewers already
   read over SFTP, so *looking* needs nothing.)
4. Terminal copy-paste — inherent, user-mediated, fine for snippets.

Not channels, by design: shared filesystems, background VM→host sync,
anything agent-triggerable.

**Opt-in mirror**, via the same paired-local-copy flow remote projects already
have, for users who want host-side durability or local tooling. When enabled,
one added knob, default ON for VM projects: **manual pull only**. Background
passes may *push* mirror→VM and *fetch* refs for status, but nothing VM→mirror
lands without a click (the ordinary confirmed pull, plus "view diff before
pull" — already deferred by the SSH local-sync work; this tier is the
reason to build it). Rationale: the mirror is the host-side artifact other
tools and the user's editor read; auto-landing agent-written bytes there would
quietly re-open the half-in/half-out hole this tier exists to close. Byte-sync
auto markers: creation leaves the manifest empty (nothing crosses);
"Pull outputs"-style explicit transfers cover artifacts.

## Phases

**Phase 0 — Runtime + image groundwork.** `vm_doctor`; base image fetch with
checksum; state-dir layout; `vm.json`. Tests: doctor probe parsing, argv
builders (pure), image version/checksum logic.

**Phase 1 — Lifecycle service.** Overlay + seed generation, keypair, boot
(daemonize/pidfile/QMP), SSH-readiness poll, shutdown, startup sweep, port
allocation + `RemoteSpec` rewrite. Tests: argv/QMP command construction,
sweep against fake pidfiles, port-rewrite plumbing. Live QA (user): boot a
stock cloud image, ssh in by hand.

**Phase 2 — Remote-project integration.** Creation path (dialog three-way,
mirror + `remote`+`vm` specs), boot-on-activate → `remote_connect`, teardown
rules, delete flow, per-VM known_hosts, sandbox/VM mutual exclusion, pill
glyph + VM settings menu. Tests: schema round-trip, exclusion guard, the
`sanitize`-style refusals, and the no-local-fallback guard — a tab spawn for
a VM project with the VM down must refuse, never spawn a host shell. Also the
"Download to…" per-file/folder SFTP exit (mirrorless projects have no other
casual file exit). Live QA: full loop — create, tab in VM, edit,
commit, lockstep pull to mirror, deactivate, reactivate, delete.

**Phase 3 — Baked base image.** `vm_build_base` provisioning boot + build
tab UX + versioning; agent CLI login flow documented in-app. Live QA: fresh
VM project to working Claude tab in under a minute.

**Phase 4 — Egress proxy.** Allowlisting CONNECT proxy task, guestfwd wiring,
three-mode knob, blocked-connection surfacing, clone-time temporary allow.
Tests: proxy allow/deny unit tests, slirp argv per mode.

**Phase 5 — Opt-in mirror + untrusted-tier sync knob.** Wire the existing
paired-mirror opt-in for VM projects; manual-pull-only mode in `git_peer`
scheduling + the view-diff-before-pull viewer; unpushed-commits surfacing for
mirrorless projects. Tests: scheduler gating.

**Phase 6 (deferred).** macOS (Virtualization.framework), Windows (Hyper-V or
WSL2 backend), snapshots ("reset VM to post-clone state"), background-running
VMs, local-model-only fully-closed profile.

## Open questions

1. **Base distro/arch pinning** — Ubuntu LTS x86_64 first; aarch64 hosts later
   (affects image fetch matrix, not architecture).
2. **Resource defaults vs. this machine** — 4 GB/2 cpu default; should the
   dialog read host free memory and warn? (Renderer-watchdog machine history
   says yes, cheaply.)
3. **Where the CONNECT proxy allowlist lives** — per-project (`vm.egress`) with
   a global default list in settings; needs a decision on whether agents' MCP
   endpoints get wildcarded or enumerated.
4. **tmux inside the VM** — shell tabs should ride the existing tmux-session
   machinery pointed at the VM host so an app restart reattaches; expected to
   Just Work via `remote_host` plumbing, but verify in Phase 2 QA.
5. **Mirror read-only enforcement** — for opted-in mirrors, beyond "manual
   pull only", should the mirror dir be advisory-read-only on disk (perms) to
   stop the *user* from habitually editing the wrong copy? Leaning yes-later;
   amber "local edits ahead" lamps already cover the accident today.

## Non-goals

- No virtiofs/9p/sshfs sharing, ever, in this tier — a shared live filesystem
  is precisely the hole the tier closes.
- No libvirt dependency; no root/bridged networking.
- Not a replacement for the container toggle — that stays the cheap
  middle tier and keeps its own semantics.
- No automatic conversion of existing projects in v1 (create-new/import
  first; an explicit "convert to VM project" data-move can follow the same
  path `extend_project_to_remote` proved out).
