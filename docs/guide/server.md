# Setting up a Tabtivity server

A Tabtivity server lets a few trusted people use Tabtivity from a browser or
a phone. Their projects, agents and terminals run on one shared Linux
machine. You don't run the server by hand: you install it once, and from then
on it runs as a set of system services and starts again by itself after a
reboot.

> **Experimental.** The server version is built and tested, but nobody has
> run it on a real server yet. Expect rough edges, and please report what you
> find.

**Time needed:** about 15 minutes with the release package; about 30 when
you build from source, most of it waiting for builds.

## What you need

- **A Linux machine** that is always on. These steps assume **Ubuntu 24.04**;
  other distributions work but their package names may differ. The release
  package is for x86_64 machines with Ubuntu 24.04 / Debian 13 or newer;
  anything else builds from source. There is no Windows or macOS server: on
  such a machine, run the server in a Linux virtual machine (next section;
  on a Mac use UTM or Lima instead of virt-manager, on Windows Hyper-V).
- **`sudo` rights** on that machine.
- **[Tailscale](https://tailscale.com/download)** installed and logged in on
  the server and on every device that will use it. People reach the server
  only through your tailnet; it is never exposed to the public internet.
- In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
  **MagicDNS** and **HTTPS Certificates** switched on.

Throughout this guide, `HOST.TAILNET.ts.net` stands for your server's
Tailscale name. To find it, run this on the server and drop the trailing dot:

```bash
tailscale status --json | jq -r .Self.DNSName
```

## Optional — Run the server in a virtual machine

If the server would share a machine with your own desktop, put it in a
virtual machine. The installer then changes the VM, not your computer (the
`/proc` line, kernel settings, system accounts), the server gets a hard disk
and memory limit, and you can roll a failed install back. On the host
machine:

```bash
sudo apt install virt-manager
# Download the Ubuntu 24.04 *server* ISO, then:
sudo virt-install --name tabtivity-server --memory 16384 --vcpus 6 \
    --disk size=250,format=qcow2 --os-variant ubuntu24.04 \
    --cdrom ~/Downloads/ubuntu-24.04-live-server-amd64.iso
sudo virsh autostart tabtivity-server     # start it whenever the host boots
```

Adjust memory (MB), CPUs and disk (GB) to taste. The disk file grows as it
fills, up to the size given. Install Ubuntu in the window that opens, then
take a snapshot:

```bash
sudo virsh snapshot-create-as tabtivity-server os-installed
```

Inside the VM, install Tailscale and log in. The VM joins your tailnet as a
machine of its own, and `HOST.TAILNET.ts.net` below is the VM's name, not
your computer's. Then follow the steps below inside the VM. Take a second
snapshot before step 4; `sudo virsh snapshot-revert tabtivity-server <name>`
goes back to one.

**Just trying it out?** From a checkout of the source, one command builds a
headless VM, installs the server and does steps 4–7 for you: it joins your
tailnet, sets the server up, adds you as administrator and prints the
address and your pairing code.

```bash
scripts/server-vm.sh medium            # small, medium or large; --disk up to 500 (GB)
scripts/server-vm.sh medium 0.3.1      # later: install another version over it
scripts/server-vm.sh stop              # or start, ssh, invite, status, reset
```

That VM does not start again by itself after a reboot; for a server people
rely on, use the libvirt VM above or a dedicated machine.

**Limit:** a VM has no GPU unless you set up PCI passthrough, so the shared
local models run on the CPU only. If local models matter, use a dedicated
machine instead.

## Step 1 — Install the packages

The release package in step 2 brings what it needs (tmux, bubblewrap, git,
curl). Only if you build from source, install the build tools too:

```bash
sudo apt install git curl jq build-essential tmux bubblewrap
```

plus **Rust** ([rustup.rs](https://rustup.rs); the right version is picked
automatically) and a current **Node.js LTS** release.

Optional: `sudo apt install podman uidmap` if your users should be able to run
projects in containers. Node.js is also needed if you want to offer agent CLIs
that install through npm (Gemini); Claude and Codex don't need it.

## Step 2 — Install Tabtivity

### From a release (recommended)

Every [release](https://github.com/fseiffarth/tabtivity/releases) carries
the server as `tabtivity-server_<version>_amd64.deb`. Download the newest one
and check that it is the file the release signed:

```bash
v=$(basename "$(curl -fsSLo /dev/null -w '%{url_effective}' \
    https://github.com/fseiffarth/tabtivity/releases/latest)")
base=https://github.com/fseiffarth/tabtivity/releases/download/$v
curl -fL -O "$base/tabtivity-server_${v#v}_amd64.deb" \
    -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.sig"
curl -fLo release-signing.pub.pem \
    https://raw.githubusercontent.com/fseiffarth/tabtivity/main/src-tauri/release-signing.pub.pem
openssl dgst -sha256 -verify release-signing.pub.pem -signature SHA256SUMS.sig SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

Both checks must say `Verified OK` and `OK`. They prove the package is the file
the release signed with the key you just downloaded — and that key comes from the
same repository as the release, so they do not prove the key is the maintainer's.
Compare its fingerprint with one published somewhere other than this repository:

```bash
openssl pkey -pubin -in release-signing.pub.pem -outform DER | sha256sum
```

*Open item (threat-model recheck 2026-10-24):* that fingerprint has not been
published outside the repository yet (see `docs/context/release_signing.md`), so
there is nothing to compare it with until it is. Until then the check above is an
integrity check against the repository, not an independent one.

Then install it:

```bash
sudo apt install "./tabtivity-server_${v#v}_amd64.deb"
```

The package puts the programs in `/usr/lib/tabtivity/` and the web pages in
`/usr/share/tabtivity/`. It doesn't start anything yet; step 4 does.

### From source

```bash
git clone https://github.com/fseiffarth/tabtivity.git
cd tabtivity
npm ci
npm run build
cargo build --release -p app-serverd -p app-gateway
sudo install -D -m 0755 target/release/tabtivity-serverd \
    target/release/tabtivity-gateway target/release/tabtivity-admin-helper \
    -t /usr/lib/tabtivity/
sudo mkdir -p /usr/share/tabtivity
sudo cp -r web-dist mobile-dist /usr/share/tabtivity/
```

`scripts/package-server-deb.sh` builds the same `.deb` the release ships, if
you would rather install a package.

## Step 3 — A short name for the admin tool

To save typing, give the admin tool a short name for the rest of this guide:

```bash
alias tt-admin='sudo /usr/lib/tabtivity/tabtivity-admin-helper'
```

## Step 4 — Install the services

First see what the installer will do. This changes nothing:

```bash
tt-admin --dry-run install --origin https://HOST.TAILNET.ts.net \
    --content-origin https://HOST.TAILNET.ts.net:8443
```

If the plan looks right, run the same command without `--dry-run`:

```bash
tt-admin install --origin https://HOST.TAILNET.ts.net \
    --content-origin https://HOST.TAILNET.ts.net:8443
```

The installer creates the server's own system accounts, installs the services
and starts them. At the end it prints **one line to add to `/etc/fstab`**.
That line hides each user's processes from the other users. Add it (replacing
any existing line that starts with `proc`), then apply it:

```bash
sudo nano /etc/fstab            # paste the printed line
sudo mount -o remount /proc
```

## Step 5 — Make it reachable over Tailscale

```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:8740
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8741
```

Use **Serve**, never **Funnel**. Funnel would put the server on the public
internet.

## Step 6 — Check everything

```bash
tt-admin check
```

Every line should start with `ok`. `warn` lines are optional features (for
example containers without Podman). After installing, `socket_dir` may say
`warn` until the next reboot.

For each `FAIL`, the message says what is wrong. The usual ones are:

| Check | Fix |
|---|---|
| `hidepid` | The `/etc/fstab` line from step 4 is missing or not applied yet. |
| `ptrace_scope` | `echo kernel.yama.ptrace_scope=1 \| sudo tee /etc/sysctl.d/60-tabtivity.conf && sudo sysctl --system` |
| `userns` | Ubuntu 24.04 blocks the agent sandbox by default. Either enable the `bwrap-userns-restrict` AppArmor profile, or run `echo kernel.apparmor_restrict_unprivileged_userns=0 \| sudo tee /etc/sysctl.d/60-tabtivity-userns.conf && sudo sysctl --system` |
| `tmux` | Install tmux 3.2 or newer. |
| `funnel` | Turn Funnel off for the server's ports (`tailscale funnel --https=<port> off`). |

Run `tt-admin check` again until there are no `FAIL` lines.

## Step 7 — Add yourself and others

```bash
tt-admin user-add alice --admin     # you, as the administrator
tt-admin user-add bob               # everyone else
```

Each command prints a **pairing code** like `alice:12345678`. Give it to that
person. Each code works only once. For another device, make a new code:

```bash
tt-admin invite alice
```

User names use lowercase letters, digits and `_` only (no dashes). If a Unix
account with that name already exists, it is reused. Accounts that have
admin rights on the machine (`sudo`, `docker`, …) are refused.

## Step 8 — Install the agent CLIs

Only the administrator installs agent CLIs, once, for everybody:

```bash
tt-admin cli-install claude
tt-admin cli-install codex
```

Run the same command again later to update a CLI.

## Step 9 — Open it

On a phone or laptop that is on your tailnet:

1. Open `https://HOST.TAILNET.ts.net/`.
2. Enter your pairing code.
3. On a laptop, then open `https://HOST.TAILNET.ts.net/desktop/` for the full
   desktop interface.

Each person signs in to their own agent accounts (Claude, Codex, …) from
inside their own agent tabs.

## Day-to-day

| Task | Command |
|---|---|
| Is the server running? | `systemctl status tabtivity-gateway` |
| Restart the server | `sudo systemctl restart tabtivity-gateway` |
| Restart one person's session | `sudo systemctl restart tabtivity-serverd@bob` (their agents keep running) |
| A lost or stolen device | `tt-admin device-revoke bob <device id>` (ids in `/var/lib/tabtivity-gateway/gateway.json`) |
| Make someone admin, or not | `tt-admin role bob admin` / `tt-admin role bob user` |
| Remove someone | `tt-admin user-remove bob` (their Unix account and files stay) |
| Who did what | `sudo cat /var/lib/tabtivity-gateway/audit.jsonl` |
| All admin commands | `tt-admin help` |

**Updating:** with the release package, download and check the new one as in
step 2, then `sudo apt install ./tabtivity-server_<version>_amd64.deb`. The
package restarts every server service that is running: the gateway, each
person's session, and the key, sharing and calendar services (restarting
only the gateway would leave the rest on the old version).

From source: pull the new version, build it and copy it into place (step 2),
then restart every server service yourself:

```bash
cd tabtivity && git pull
npm ci && npm run build
cargo build --release -p app-serverd -p app-gateway
sudo install -D -m 0755 target/release/tabtivity-serverd \
    target/release/tabtivity-gateway target/release/tabtivity-admin-helper \
    -t /usr/lib/tabtivity/
sudo rm -rf /usr/share/tabtivity/web-dist /usr/share/tabtivity/mobile-dist
sudo cp -r web-dist mobile-dist /usr/share/tabtivity/
for u in tabtivity-gateway tabtivity-auth-keeper tabtivity-keybroker \
    tabtivity-hub tabtivity-calendar \
    $(systemctl list-units --plain --no-legend 'tabtivity-serverd@*.service' | awk '{print $1}'); do
  sudo systemctl try-restart "$u"
done
```

Agents keep running during the restart: their tabs live in tmux, which is
not restarted.

## Proxies and remote images

Tabtivity checks where a fetch is going before it connects, and a web proxy
would resolve the name itself and skip that check. So a markdown image from
the web (after "Load images"), the assistant's web tools, and a reader page or
calendar feed fetched by the server for a client never use `HTTP_PROXY` /
`HTTPS_PROXY`; a server also refuses a client's reader or calendar URL that
points at the server itself or its private network. If the server (or a
desktop) reaches the internet only through a proxy, those remote markdown
images do not load; pages you type into a reader tab on a desktop still use the
proxy.

## More

- [Signing in with your organisation's account](../../DOCUMENTATION.md#hosted-server-signing-in-with-your-organisations-account):
  single sign-on instead of pairing codes
- [Project containers](../../DOCUMENTATION.md#hosted-server-project-containers)
- [The desktop app as a client](../../DOCUMENTATION.md#hosted-server-the-desktop-app-as-a-client)
- [The secrets key](../../DOCUMENTATION.md#hosted-server-the-secrets-key)
- [The administrator's agent API keys](../../DOCUMENTATION.md#hosted-server-the-administrators-agent-api-keys)
- [Sharing projects and calendars](../../DOCUMENTATION.md#hosted-server-sharing-projects-and-calendars)
- How it is built, and why: [docs/server.md](../server.md)
