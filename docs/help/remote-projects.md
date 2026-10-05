---
id: remote-projects
title: Remote (SSH) projects, VPN and compute machines
keywords: [remote, ssh, sftp, host, server, cluster, hpc, slurm, vpn, openvpn, extend, machines, worker, tmux, sessions]
---

A project can live on another machine. Tabtivity works with it over SSH and SFTP:
no sshfs, no FUSE mount, nothing to install on the host.

## Create a remote project

1. Click `+` beside the project pills → **New Project** or **Import Project**.
2. Tick **Remote (SSH) project** at the top of the dialog.
3. Pick a **Local location** — where the synced local working copy (the
   mirror) will live. The default is under `~/tabtivity/projects-ssh/`.
4. Enter the SSH address as `user@host` or `host:2222`. Leave the password
   blank to use your SSH key or agent; fill it in for password login.
5. Click **Connect**. A remote file browser appears.
6. Step into the folder you want and click **Use this folder**. New creates a
   subfolder there; Import registers the folder in place.
7. Name the project, pick a Git hosting option, and click Create/Import.

Passwords are not saved unless you opt in; a saved password goes to the OS
keychain, keyed by host.

## Where things run

- Agent tabs work in the local mirror by default.
- Shells run on the host (`ssh -tt`); file browsing and git go over SFTP/SSH.
- The pill's connection lamp shows the SSH state; click it to reconnect.
- Probes and sync only run while the project is connected, so a dead
  connection never hangs the window.

## Extend a local project to a remote

1. Right-click the local project's pill → **Extend to remote…**.
2. Connect to the host (or pick one under "Your machines").
3. Browse to the parent folder where the host copy should live → **Use this
   folder**, then review Local ⇄ Remote and click **Extend to remote**.
4. Your local files are not touched: they become the mirror, and Git sync
   carries commits between the two. See `sync`.

## Hosts behind a VPN

1. In the project dialog tick **Connect via OpenVPN**, pick your `.ovpn`
   config (Tabtivity copies it into its own store) and enter its credentials.
2. Click **Connect VPN** (pkexec asks for elevation), then connect SSH.

The tunnel is machine-wide, not per project: the header's OpenVPN button
brings it up or down and can arm "Connect on launch" once saved credentials
make the connect silent. Needs `openvpn` and polkit installed.

## Compute machines (workers)

A remote project can reach more than one host.

1. Right-click the pill → Runtime → **Remote machines…** (or click a lamp).
2. Add a machine. By default it shares the primary's folder over a shared
   filesystem (an HPC node on a shared home): nothing is copied. Leave
   **Sync a copy** ticked for a standalone box that gets a one-way,
   tracked-files-only copy of your code.
3. For a synced worker, **Sync code now** pushes the latest tracked files and
   **Pull outputs…** brings results back (size-confirmed).
4. New tabs can run on any attached machine.

The header's Machines indicator lets you sign in to a host once and drag it
onto any project.

## Long runs that survive (tmux)

Shell tabs — and agent tabs on a remote host — run inside tmux by default, so
a run survives an SSH drop, a laptop sleep or Tabtivity quitting. Closing a tab
only detaches it. The **Sessions** view (☰ toggle in the file panel) lists
live sessions per machine; click one to reattach, × to kill. Local agent tabs
and the root console do not use tmux, and there is no tmux on Windows.

## HPC clusters (SLURM)

`+` → **HPC pipeline…** is a 6-step wizard: log in, name the project,
allocate a workspace, upload inputs, submit a batch job, and watch it. On any
remote project with `sbatch`, a file containing `#SBATCH` lines shows a SLURM
bar (Submit job, directive form, interactive session), and the file panel's
Jobs view tracks what you launched. Hosts you tag as HPC get no background
sync loops; manual actions still work.
