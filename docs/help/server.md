---
id: server
title: The Tabtivity server — several people, one Linux machine
keywords: [server, hosted, self-hosted, multi-user, team, browser, web, gateway, install, admin, administrator, tt-admin, tabtivity-admin-helper, pairing code, invite, sign in, single sign-on, sso, oidc, connect to a server, server window, secrets key, recovery code, unlock, keyring, podman, containers, api key, key broker, budget, deb, tailscale serve]
related: [server-sharing, mobile, agent-clis, containers-boxes]
---

A Tabtivity server lets a few trusted people use Tabtivity from a browser, a
phone or the desktop app, while their projects, agents and terminals run on
one shared Linux machine. It is **experimental**: built and tested, but not
yet run on a real server for long.

## What it needs

- A Linux machine that is always on (Ubuntu 24.04 or Debian 13 or newer for
  the release package; anything else builds from source). On Windows or
  macOS, run it in a Linux virtual machine.
- `sudo` on that machine.
- **Tailscale** on the server and on every device that uses it, with MagicDNS
  and HTTPS certificates on. People reach the server only through your
  tailnet; it is never on the public internet.

## Setting it up (administrator)

The full walk-through, with every command, is in the project's
`docs/guide/server.md`. In short:

1. Download `tabtivity-server_<version>_amd64.deb` from the releases page,
   check its signature, `sudo apt install` it.
2. `tabtivity-admin-helper install --origin https://HOST.TAILNET.ts.net
   --content-origin https://HOST.TAILNET.ts.net:8443` (try `--dry-run` first),
   then add the `/proc` line it prints to `/etc/fstab`.
3. `tailscale serve` ports 443 and 8443 to the server — **Serve, never
   Funnel**.
4. `tabtivity-admin-helper check` until no line says `FAIL`.
5. `user-add <name> --admin` for yourself, `user-add <name>` for others: each
   prints a one-time **pairing code** (`name:12345678`); `invite <name>` makes
   another for a new device.
6. `cli-install claude` (and others) installs the agent CLIs once for
   everybody.

Updating is installing the newer `.deb`; it restarts every server service,
and agents keep running in tmux. To try it out, `scripts/server-vm.sh` in a
source checkout builds a test server in a virtual machine in one command.

## Using it

- On a phone or laptop on the tailnet, open `https://HOST.TAILNET.ts.net/`
  and enter your pairing code. On a laptop, `https://HOST.TAILNET.ts.net/desktop/`
  is the full desktop interface.
- Each person signs in to their own agent accounts from inside their own
  agent tabs, as on the desktop.
- In the browser, "this computer" means the server: a file picker shows the
  server's files. A few actions need the computer you sit at (for example
  parking its windows); the browser says so instead of running them.

## Signing in with your organisation's account

If the administrator connected the server to an identity provider (for
example a university's single sign-on), the pairing page shows **Sign in with
…** above the invite-code field. It works for people the administrator linked
to an account, and pairs the browser or phone like an invite code would. The
administrator sets it up with `oidc-set` and links people with `user-oidc NAME
--sub <their id>`.

## The desktop app as a client

**Settings → Remote & mobile → Mobile → Connect to a server**: the server's
address, an invite code and a name for this computer → **Pair**, then **Open
the server window**. That window shows the server's workspace, beside your
own, never mixed. Opening a server file downloads it into your Downloads
folder and opens it here (documents, pictures, text and media; anything else
is only saved). **Forget this server** removes this computer's key.

## The secrets key

On a server, your mail and the passwords and tokens you chose to save are
sealed under one **secrets key**, kept in memory, never on disk in the clear.
After a reboot of the server it stays locked until one of your paired devices
signs in, or you type your **recovery code**. Manage it in **Settings → Mobile
→ Server → Secrets key**: **Set up the key** and **New recovery code** (shown
once, stored nowhere) — do this from the phone app or a browser you paired.

- **Revoking a device changes the key** and re-seals everything; your mail is
  re-encrypted in the background. Make a new recovery code afterwards, as the
  panel recommends.
- If a device reports **"This server's identity key changed"**, enter your
  recovery code: the device checks the new key against it without sending it.
  A code that should fit but doesn't means it is not your server.
- Agents in sandboxed tabs cannot read the key. Your own shell tabs, an SSH
  login as you and project scripts you allowed can — by design; the key
  protects your data at rest. The server's root can read a running service.

## Project containers on a server

"Run this project in a container" works once the administrator switches
**Project containers** on (needs `podman` and `uidmap`). Your containers are
rootless Podman containers running as you; nobody else on the server can see
or enter them.

## API keys from the administrator

Everyone signs in to agent CLIs with their own login by default. The
administrator may offer an API key per CLI (Claude, Gemini) to chosen users
under **Settings → Mobile → Server → Agent credentials**; those users then
pick **the administrator's API key** under **runs on** in Manage CLIs. The key
never enters an agent. A Claude key can go **through the key broker**: users
never receive it, and each gets a **monthly budget** in tokens. See
`agent-clis` for API keys in general.

## Sharing

Projects, calendars and to-do lists can be shared between users of the same
server: see `server-sharing`.

## Day-to-day administration

| Task | Command |
|---|---|
| Is it running? | `systemctl status tabtivity-gateway` |
| Restart one person's session | `sudo systemctl restart tabtivity-serverd@NAME` (agents keep running) |
| A lost or stolen device | `tabtivity-admin-helper device-revoke NAME <device id>` |
| Make someone admin, or not | `tabtivity-admin-helper role NAME admin` / `… user` |
| Remove someone | `tabtivity-admin-helper user-remove NAME` (their account and files stay) |
| Who did what | `/var/lib/tabtivity-gateway/audit.jsonl` |
| Everything else | `tabtivity-admin-helper help` |
