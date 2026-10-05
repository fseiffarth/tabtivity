# Raspberry Pi as a Tabtivity Remote Machine (+ HDD-backed project storage)

Status: **plan only** — nothing here has been executed or verified.

Scope: stand a Raspberry Pi on the LAN up as a first-class Tabtivity **remote
project** host, with the project trees living on an attached **HDD** rather than
the SD card. Two halves that can be done in either order, but Part B's mount
must be in place *before* any project tree is created on it (see B4, the
empty-mount hazard).

Everything below uses placeholders — `<pi-user>`, `<pi-host>`, `<LAN-CIDR>`.
This repo is public; do not commit real hostnames, IPs or usernames into it
(`scripts/privacy-check.sh`, and `docs/context/` passim).

## Why this shape

Tabtivity's remote projects are **mount-free**: agent/terminal tabs run on the host
over `ssh -tt`, file I/O rides `ssh -s sftp`, and git runs *on the host*
(`docs/context/remote_projects.md`). Everything is the system `ssh` binary, so
the Pi needs no Tabtivity-specific software at all — only a well-behaved sshd, and
whatever tools the tabs you open expect to find (B7 / A5).

Because git runs on the host, the **HDD holds the authoritative working tree and
`.git`**, and the laptop keeps a local mirror kept in step by git lockstep +
byte-sync (`docs/context/git_sync.md`). That is what makes the mount reliability
work in Part B load-bearing rather than housekeeping.

---

# Part A — the Pi as a remote machine

## A1. OS baseline

- **Raspberry Pi OS Lite (64-bit)** — no desktop; every Tabtivity surface is
  headless. 64-bit matters for anything you'll run under an agent tab (node,
  rust toolchains, modern Python wheels).
- Flash with Raspberry Pi Imager, and in its settings pane pre-set: hostname,
  your **SSH public key**, locale, and Wi-Fi if not wired. This gets you to a
  keys-only login without ever enabling password auth.
- Prefer **wired Ethernet**. SFTP file listing and git bundle transfer are
  latency-sensitive; Wi-Fi turns a snappy file tree into a laggy one.
- First boot:
  ```bash
  sudo apt update && sudo apt full-upgrade -y
  sudo raspi-config nonint do_hostname <pi-host>
  sudo reboot
  ```

## A2. Stable address

Tabtivity stores `host` verbatim in the project's `remote` spec and resolves it
through `~/.ssh/config` via `ssh -G` (`ssh_common.rs:resolve_host_port`). So any
of these work as the Host field — pick one and make it stable:

1. **DHCP reservation** in the router, tied to the Pi's MAC. Cleanest: the Pi
   stays DHCP-configured, the address never moves.
2. **mDNS** — `<pi-host>.local`. Zero config, but flaky across some VLANs and
   slower to resolve; fine as a fallback, poor as the recorded host.
3. **`~/.ssh/config` alias** on the laptop — recommended regardless:
   ```
   Host pi
       HostName <pi-host>.lan
       User <pi-user>
       IdentityFile ~/.ssh/id_ed25519
       IdentitiesOnly yes
       ServerAliveInterval 30
   ```
   Then the Tabtivity Host field is just `pi`, and re-addressing the Pi later is a
   one-line edit that every Tabtivity surface picks up, because none of them pass
   `-F` or bypass the config.

A static IP configured *on the Pi* is the option I'd avoid — it drifts out of
sync with the router's view and bites on network changes.

## A3. Harden sshd

Do this from a session you keep open, and verify key login works before turning
passwords off.

`/etc/ssh/sshd_config.d/10-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers <pi-user>
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
```

```bash
sudo sshd -t && sudo systemctl restart ssh
```

Then, still on the LAN:

```bash
sudo apt install -y ufw fail2ban
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <LAN-CIDR> to any port 22 proto tcp
sudo ufw enable
```

**Key-only auth is not just hygiene here** — it is what unlocks Tabtivity's
auto-connect. A connect that used no password records `remote.key_auth` on the
project (`src-tauri/src/schema/project.rs`), which is one of the two conditions
that make the **auto-connect** toggle available (the other being a saved
password, which you then never need). See `docs/context/remote_autoconnect.md`.

## A4. sshd concurrency — the one non-obvious setting

An active Tabtivity remote project multiplexes over **one pooled ControlMaster**
(`ControlMaster=auto`, `ControlPersist=600`, shared `cm-%C` socket), so tabs,
SFTP and git ride a single TCP connection. That keeps you well under any sane
limit. But if you ever run **multiple remote projects** on the same Pi, or add it
as a worker host (`docs/context/multi_host_remote.md`), each gets its own pool
entry keyed `(project, host)`, i.e. its own master.

Default `MaxSessions 10` / `MaxStartups 10:30:100` is fine for a handful. Raise
`MaxSessions` only if you see channel-open failures with many tabs open:

```
MaxSessions 20
```

## A5. Tools the tabs expect

Nothing is required for a plain shell tab. Install per the tab types you intend:

| You want | Install on the Pi |
|---|---|
| Shell/script tabs that survive SSH drops | `tmux` — **required**; remote persistence is default-ON per project (`docs/context/tmux_sessions.md`) |
| Git-backed project (lockstep) | `git` |
| Claude agent tabs on the Pi | Node + the Claude Code CLI |
| Python runs | `python3`, `python3-venv` |
| File search in the tree | `ripgrep` (falls back gracefully, but slowly) |

```bash
sudo apt install -y tmux git ripgrep python3-venv
```

Note the Pi is ARM64 and modest: agent tabs *run* there fine, but a heavy build
will be slow. The point of this host is storage + always-on, not compute.

## A6. Register it in Tabtivity

New remote project → the remote section (`RemoteProjectSection.tsx`) asks for:

- **SSH address** — `<pi-user>@pi` (the config alias from A2).
- **Remote path** — point this at the HDD: `/mnt/projects/<name>` (Part B).
- **OpenVPN** — leave **off**. It's for `.ovpn` tunnels; a LAN Pi needs none.
- **Persistent sessions (tmux)** — leave **on** (default).
- **HPC host tag** — leave **off**. That tag suppresses background scans, sync
  loops and auto-connect (`docs/context/hpc_careful_mode.md`); correct for a
  cluster login node, wrong for a Pi you want behaving normally.

First connect **from the LAN**, so `StrictHostKeyChecking=accept-new` writes the
Pi's key to `known_hosts` while you're on a network you trust.

Then enable **auto-connect** on the project — eligible thanks to `key_auth` from
A3, so it connects on launch and on activation with no prompt.

## A7. Reaching it from outside the LAN (optional)

Tabtivity is transport-agnostic here — it only needs the host to be reachable by
plain `ssh`. Two workable shapes:

- **Tailscale** — `curl -fsSL https://tailscale.com/install.sh | sh` on the Pi,
  then set the `HostName` in the laptop's `~/.ssh/config` to the tailnet name.
  Nothing port-forwarded, works behind CGNAT. Add `sudo ufw allow in on tailscale0`.
- **WireGuard** (self-hosted) — forward UDP only; `HostName` becomes the wg address.

**Caveat:** the project's `openvpn` field is OpenVPN-specific. Tabtivity cannot
bring a Tailscale/WireGuard tunnel up for you, so there's no "unreachable →
start tunnel" recovery on that path — it just shows a red lamp. Both are
boot-enabled systemd services, so in practice the tunnel is simply always up.

---

# Part B — the HDD as project storage

## B1. Hardware

- **2.5" USB drive**: usually fine bus-powered on a Pi 4/5.
- **3.5" drive**: needs its own PSU, or a **powered** USB hub. An
  under-powered drive browns out mid-write; on a filesystem holding git repos
  that is how you get corruption.
- Prefer a USB 3.0 port (blue) on Pi 4/5.
- Some USB-SATA bridges misbehave under UAS. If you see resets in `dmesg`,
  disable UAS for that bridge by adding to `/boot/firmware/cmdline.txt` (one
  line, appended):
  ```
  usb-storage.quirks=<vid>:<pid>:u
  ```
  Get `<vid>:<pid>` from `lsusb`.

## B2. Partition and filesystem

**Use ext4.** Not exFAT, not NTFS: those carry no POSIX ownership or permission
bits, which breaks `.ssh`-adjacent permission checks, breaks git's executable
bit and symlinks, and makes ownership of the tree meaningless. btrfs is a
reasonable alternative if you want snapshots, but ext4 is the boring correct
default here.

```bash
lsblk -o NAME,SIZE,MODEL,TRAN          # identify the disk — check twice
sudo wipefs -a /dev/sdX                # DESTRUCTIVE
sudo parted /dev/sdX mklabel gpt
sudo parted -a opt /dev/sdX mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L projects /dev/sdX1
```

Reserve less space for root on a data-only disk (default 5% is a lot on 4 TB):

```bash
sudo tune2fs -m 1 /dev/sdX1
```

## B3. Mount by UUID, never by `/dev/sdX`

Device names reorder across reboots. Get the UUID:

```bash
sudo blkid /dev/sdX1
```

`/etc/fstab`:

```
UUID=<uuid>  /mnt/projects  ext4  defaults,noatime,nofail,x-systemd.device-timeout=30  0  2
```

- `noatime` — fewer writes, meaningfully faster on a spinning disk under a file
  tree that gets walked a lot.
- `nofail` — the Pi still boots if the disk is absent. **Necessary, and exactly
  what creates the hazard in B4.**
- `x-systemd.device-timeout=30` — don't hang boot for 90s waiting on a dead disk.

```bash
sudo mkdir -p /mnt/projects
sudo systemctl daemon-reload
sudo mount -a && findmnt /mnt/projects
```

## B4. The empty-mount hazard — do not skip this

With `nofail`, a disk that fails to appear leaves `/mnt/projects` as an **empty
directory on the SD card**. Tabtivity then connects successfully, SFTP lists an
empty tree, and git on the host sees a non-repo. That is not a harmless "no
files" state: byte-sync and lockstep are designed around the host being
authoritative for the remote project, and an apparently-emptied host tree is
the worst possible input to a sync pass. Tabtivity does record destructive
outcomes (`services::local_loss`, `LocalLossDialog` — see
`docs/context/git_sync.md`), but the correct move is to make the bad state
impossible to write into.

**Guard: make the bare mountpoint immutable.**

```bash
sudo umount /mnt/projects
sudo chattr +i /mnt/projects      # while EMPTY and UNMOUNTED
sudo mount /mnt/projects          # mounting over it works; the flag applies to the SD-card dir
```

Now, if the HDD is missing, every write to `/mnt/projects` fails loudly with
`EPERM` instead of silently landing on the SD card. A failed sync is recoverable;
a silently-diverged one is not.

**Second guard: a sentinel.** After mounting, create `/mnt/projects/.mounted`.
Any script (or your own `ssh pi 'test -f /mnt/projects/.mounted'`) can then
distinguish "mounted" from "empty" in one call. Worth wiring into a
pre-sync habit if you automate anything.

## B5. Ownership and permissions

```bash
sudo mkdir -p /mnt/projects
sudo chown -R <pi-user>:<pi-user> /mnt/projects
sudo chmod 755 /mnt/projects
```

The whole tree must be owned by the SSH user, not root — SFTP writes and host-side
git both run as that user. If ownership ends up mixed, git will refuse the repo
with a `dubious ownership` error; fix the ownership rather than papering over it
with `safe.directory`.

## B6. Lay out the projects

```bash
mkdir -p /mnt/projects/<name>
cd /mnt/projects/<name> && git init
```

Then set the Tabtivity project's **Remote path** to `/mnt/projects/<name>` (A6).

Keep one directory per project. Do not nest a project inside another project's
tree — the file tree, search and sync all take the remote path as the root.

## B7. Reliability

- **Disable aggressive spin-down.** A parked drive costs 5–10 s on the first
  access, and that lands on your first file-tree expansion or first git call,
  which reads as Tabtivity hanging. If the drive supports it:
  ```bash
  sudo apt install -y hdparm
  sudo hdparm -S 0 /dev/sdX          # never spin down
  ```
  Persist it in `/etc/hdparm.conf`. If you'd rather save the power, accept the
  stall and know what it is.
- **SMART monitoring:**
  ```bash
  sudo apt install -y smartmontools
  sudo smartctl -a /dev/sdX | head -30
  ```
  Enable `smartd` with an email or a log check; a Pi HDD is usually a
  second-hand drive and will fail eventually.
- **The HDD is not a backup.** It's a single disk holding the authoritative
  copy of your work. Two mitigations, both cheap:
  - Push to a git remote (the local mirror on your laptop is *already* a second
    copy of everything tracked — that's what lockstep gives you for free).
  - `restic`/`borg` the untracked parts to a second disk or off-site.
- **SD card wear:** with the tree on the HDD, the card only carries the OS.
  Consider `log2ram` if you want to reduce card writes further.

## B8. Power and boot order

If the Pi is on a UPS-less socket, an unclean shutdown mid-write is the realistic
failure mode. ext4's journal handles the filesystem; git's index is also fairly
robust. Still worth:

```bash
sudo systemctl enable systemd-fsck-root
```

and a periodic `fsck` schedule via `tune2fs -c`/`-i` if the Pi runs for months.

---

# Verification checklist

Run through this once, end to end, before trusting the setup with real work.

**Part A**
1. `ssh pi true` from the laptop — succeeds, no password, no prompt.
2. `ssh -o PasswordAuthentication=no -o PubkeyAuthentication=no pi` — rejected.
3. `sudo ufw status` — 22 open only to `<LAN-CIDR>`.
4. `ssh pi 'tmux -V; git --version'` — both present.

**Part B**
5. `ssh pi 'findmnt /mnt/projects'` — shows the ext4 device.
6. `ssh pi 'touch /mnt/projects/<name>/x && rm /mnt/projects/<name>/x'` — succeeds as `<pi-user>`.
7. Unmount test: `sudo umount /mnt/projects && touch /mnt/projects/x` — **must fail**
   with permission denied (B4's immutable guard). Remount afterwards.
8. `sudo reboot`, then re-check 5 — the fstab entry survives a reboot.

**Tabtivity** (needs a running instance — the user drives this, not an agent)
9. Project connects from the pill's connection lamp; SSH lamp goes green.
10. File tree expands the remote path and shows the HDD contents.
11. A shell tab opens; `df -h .` inside it reports the HDD, not the SD card.
12. Close Tabtivity, reopen — the shell tab **reattaches** its tmux session.
13. Auto-connect: relaunch with the project active — it connects with no prompt.
14. Commit on the Pi, confirm lockstep brings it to the local mirror.

---

# Open questions / decisions deferred

- **Filesystem**: ext4 assumed. btrfs would buy snapshots (a nice safety net
  against a bad sync pass) at the cost of more moving parts on ARM.
- **Outside-LAN access**: A7 lists two options but doesn't pick one; it isn't
  needed for the LAN-only case and can be added later without touching anything
  else, since only `HostName` in `~/.ssh/config` changes.
- **The Pi as a worker host** rather than a project primary
  (`docs/context/multi_host_remote.md`) — push-only sync, read-only files — is a
  different shape and out of scope here. Worth revisiting if the Pi ends up
  running jobs rather than holding files.
