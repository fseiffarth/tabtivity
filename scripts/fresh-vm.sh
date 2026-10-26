#!/usr/bin/env bash
#
# One desktop VM to see Tabtivity the way a brand-new user does: no state
# dir, no agent logins, no ~/.claude, and the package's dependencies resolved
# by apt the way a user's machine would. The same VM serves every version:
# each call only swaps the installed Tabtivity.
#
# Run it on the host, outside an agent fence (it needs /dev/kvm). It never
# touches libvirt, the running Tabtivity or its state.
#
#   scripts/fresh-vm.sh [--fresh] [<version|latest|current|file.deb|file.AppImage>]
#       the one call. With a VM already there it ONLY UPDATES Tabtivity inside
#       it: no question, no new VM, no base rebuild, the VM's state (accounts,
#       settings, logins, open tabs' files) kept; up or down in version.
#         VM stopped: it boots with the package installed before the desktop
#                     appears (a disc the guest installs at boot).
#         VM running: the package is copied into the running guest through the
#                     QEMU guest agent (checked against its SHA-256), installed
#                     there as root with the same install.sh the boot disc
#                     carries, the running app is quit and started again as
#                     `tester`. Nothing is silently skipped: when the guest
#                     agent does not answer (VM still booting, a base without
#                     the agent, a VM started by an older script) the call says
#                     so and what to do (close the VM window, run again: the
#                     boot path installs without the agent).
#       Only without a VM is one built: from the base image, which is baked
#       once (~15 min: Ubuntu 24.04 + minimal GNOME, auto-login as `tester`,
#       password `tester`, no setup wizard, no screen lock). --fresh is the
#       only way to a clean desktop (a brand-new user's first run): it deletes
#       the VM (asking first when it is running) and starts a new one.
#       The target: `latest` (default) or a <version> of the GitHub release;
#       `current` the newest package built in this checkout
#       (target/release/bundle/{deb,appimage}; never built by this script:
#       `APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:bundle`; the file, version
#       and build time are printed); or a package file. A package is installed
#       once: the VM records its file name AND content hash, so a rebuild at
#       the same version is installed again and the very same file is not.
#
#   Desktop entry "Tabtivity (VM)": the same call (latest), a click away,
#       in the app grid and as an icon on the desktop: an update in place of
#       the VM that is there, running or not (never a question, never a new
#       VM). Every host run of this script from the checkout writes it and
#       refreshes the copy of the script it runs (under the VM folder, never
#       the checkout's: an agent can edit the checkout). Clicked, it logs to
#       <VM folder>/launcher.log and reports the long first build and any
#       failure as a notification.
#
#   scripts/fresh-vm.sh boot               open the VM, install nothing (running:
#                                          just start the app in it)
#   scripts/fresh-vm.sh repair             repair/start the running VM's desktop
#   scripts/fresh-vm.sh reset              back to a clean desktop
#   scripts/fresh-vm.sh status             running or not, what is installed
#                                          (asked of the running guest), sizes
#   scripts/fresh-vm.sh base --rebuild     build the base image again
#
# The VM keeps its state between versions, so `0.2.9` after `0.2.8` is an
# update of a used install. The VM is a copy-on-write disk over the
# read-only base, so --fresh and reset take a second.
# A .deb replaces the installed package; an AppImage lands in the home
# folder beside it (older AppImages placed there are removed).
# Release packages are checked against the release's SHA256SUMS (the
# signature over that file is not checked).
#
# Files: ~/.local/share/<slug>-fresh-vm (override: <PREFIX>FRESH_VM_DIR).
# Guest size: <PREFIX>FRESH_VM_MEM (MiB, 6144), <PREFIX>FRESH_VM_CPUS (4).
# Guest login: tester / tester. Boot output: <VM folder>/serial.log.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_REPO, …
. "$ROOT/scripts/lib/brand.sh"
# dev_on_host, dev_desktop_quote
. "$ROOT/scripts/lib/dev-launcher.sh"

DIR="$(app_env FRESH_VM_DIR "$HOME/.local/share/$APP_SLUG-fresh-vm")"
MEM="$(app_env FRESH_VM_MEM 6144)"
CPUS="$(app_env FRESH_VM_CPUS 4)"
CLOUD_URL="https://cloud-images.ubuntu.com/noble/current"
CLOUD_IMG="noble-server-cloudimg-amd64.img"
BASE="$DIR/base.qcow2"
VM="$DIR/vm.qcow2"
PKG_ISO="$DIR/package.iso"
INSTALLED="$DIR/installed"
# The QEMU guest agent's socket: how the host starts the app in a running VM.
QGA_SOCK="$DIR/qga.sock"
CACHE="$DIR/packages"
# The guest's network is QEMU's user-mode NAT; a fixed MAC keeps the netplan
# config cloud-init wrote at bake time matching on every later boot.
NIC="user,model=virtio-net-pci,mac=52:54:00:4e:f0:01"
# Keep the baked image's standard VGA on the same PCI slot at every boot.
# An explicit `-device virtio-vga` replaces QEMU's implicit VGA and moves the
# NIC as well: a different GPU/adapter name can strand GDM or network-online.
# Use the same hardware for the headless bake and the desktop, including old
# bases which were baked with QEMU's default standard VGA.
VIDEO=(-vga std -global VGA.xres=1600 -global VGA.yres=1000)
PKG_LABEL="FRESHPKG"
LAUNCHER="$DIR/launcher"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_ENTRY="$DESKTOP_DIR/${APP_DISPLAY}VM.desktop"
FROM_DESKTOP=0

# A notification, only when started from the desktop entry (no terminal).
notify() {
  [ "$FROM_DESKTOP" = 1 ] && command -v notify-send >/dev/null 2>&1 || return 0
  notify-send -a "$APP_DISPLAY (VM)" "$@" || true
}

die() {
  printf 'fresh-vm: %s\n' "$*" >&2
  notify -u critical "$APP_DISPLAY (VM) did not start" "$*"
  exit 1
}
say() { printf '==> %s\n' "$*"; }

vm_running() { pgrep -f -- "file=$VM," >/dev/null 2>&1; }

# The disk is in use: a second QEMU would fail on its lock, and a reset under
# a running VM would pull its disk away.
refuse_if_running() {
  if vm_running; then
    die "the VM is already running; close its window first"
  fi
}

# --fresh while the VM is running would delete a VM someone is using: prints
# yes only when the user says so (terminal or dialog); with no one to ask, no.
confirm_fresh_running() {
  local question answer
  question="The VM is running. --fresh stops it and deletes it (its installed apps, accounts and settings), then starts a clean VM."
  if [ -t 0 ]; then
    printf '%s\n' "$question" >&2
    read -r -p 'Stop and delete it? [y/N]: ' answer || answer=n
    case "$answer" in y | Y) echo yes ;; *) echo no ;; esac
  elif [ "$FROM_DESKTOP" = 1 ] && command -v zenity >/dev/null 2>&1; then
    zenity --question --no-markup --title "$APP_DISPLAY (VM)" --text "$question" \
      --ok-label "Stop and delete it" --cancel-label Cancel >/dev/null 2>&1 && echo yes || echo no
  else
    echo no
  fi
}

# Stop the running VM: QEMU quits on SIGTERM, SIGKILL after 10 s.
stop_vm() {
  local pids i
  mapfile -t pids < <(pgrep -f -- "file=$VM,")
  [ "${#pids[@]}" -gt 0 ] || return 0
  say "stopping the running VM"
  kill "${pids[@]}" 2>/dev/null || true
  for i in $(seq 50); do
    kill -0 "${pids[@]}" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "${pids[@]}" 2>/dev/null || true
  sleep 0.5
}

# Run a program in the guest, as root, through the QEMU guest agent; prints
# its output and exits with its status (or 1 when the agent does not answer).
qga_exec() {
  local timeout=60
  if [ "${1:-}" = --timeout ]; then timeout="$2"; shift 2; fi
  python3 -I - "$QGA_SOCK" "$timeout" "$@" <<'PY_QGA'
import base64, json, socket, sys, time

path, timeout, argv = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
# --put SRC DEST: copy the host file SRC to DEST in the guest (1 MiB per
# guest-exec, fed to `cat` on stdin; the timeout is per chunk).
put = None
if argv[:1] == ["--put"]:
    try:
        put = open(argv[1], "rb")
    except OSError as e:
        sys.exit(f"cannot read {argv[1]}: {e}")
sock = socket.socket(socket.AF_UNIX)
sock.settimeout(10)
submitted = False
try:
    sock.connect(path)
    f = sock.makefile("rwb")

    def send(cmd, **args):
        f.write(json.dumps({"execute": cmd, "arguments": args}).encode() + b"\n")
        f.flush()

    def reply():
        while True:
            line = f.readline()
            if not line:
                raise OSError("the guest agent closed the connection")
            r = json.loads(line)
            if "error" in r:
                sys.exit("guest agent: " + str(r["error"].get("desc")))
            if "return" in r:
                return r["return"]

    def call(cmd, **args):
        send(cmd, **args)
        return reply()

    def run(prog, args, data=None):
        extra = {"capture-output": True}
        if data is not None:
            extra["input-data"] = base64.b64encode(data).decode()
        pid = call("guest-exec", path=prog, arg=args, **extra)["pid"]
        deadline = time.monotonic() + timeout
        while True:
            status = call("guest-exec-status", pid=pid)
            if status.get("exited"):
                return status
            if time.monotonic() > deadline:
                sys.exit("the program in the guest did not finish")
            time.sleep(0.05 if put else 0.3)

    # Skip any reply an earlier, interrupted client left in the channel.
    sync = int(time.time()) & 0x7FFFFFFF
    send("guest-sync", id=sync)
    while reply() != sync:
        pass
    submitted = True
    if put:
        dest = argv[2]

        def ok(status):
            if status.get("exitcode", 1) != 0:
                if status.get("err-data"):
                    sys.stderr.write(base64.b64decode(status["err-data"]).decode(errors="replace"))
                sys.exit(status.get("exitcode", 1))

        ok(run("/bin/sh", ["-c", 'umask 022; mkdir -p "$(dirname "$1")" && : > "$1"', "sh", dest]))
        put.seek(0, 2)
        total = put.tell()
        put.seek(0)
        sent = 0
        while True:
            chunk = put.read(1 << 20)
            if not chunk:
                break
            ok(run("/bin/sh", ["-c", 'cat >> "$1"', "sh", dest], chunk))
            sent += len(chunk)
            if total >= (16 << 20) and (sent % (16 << 20) == 0 or sent == total):
                print(f"  copied {sent >> 20} of {total >> 20} MiB", file=sys.stderr, flush=True)
        sys.exit(0)
    status = run(argv[0], argv[1:])
except (OSError, ValueError) as e:
    print(f"the guest agent does not answer ({e})", file=sys.stderr)
    if not submitted:
        print("no command was submitted to the guest", file=sys.stderr)
    sys.exit(1 if submitted else 69)
for key in ("out-data", "err-data"):
    if status.get(key):
        sys.stdout.write(base64.b64decode(status[key]).decode(errors="replace"))
sys.exit(status.get("exitcode", 1))
PY_QGA
}

# The guest's side of starting the app: the entry install.sh recorded, its
# Exec= (field codes dropped) run as a service of tester's own session, so it
# gets the desktop's environment and outlives this call.
guest_launch() {
  cat <<'EOF'
set -eu
entry=$(cat /var/lib/fresh-vm/entry 2>/dev/null) || { echo "nothing is installed in the VM yet" >&2; exit 3; }
cmd=$(sed -n 's/^Exec=//p' "$entry" | head -n 1 | sed 's/ %[A-Za-z]//g')
[ -n "$cmd" ] || { echo "$entry has no Exec=" >&2; exit 3; }
uid=$(id -u tester)
[ -S "/run/user/$uid/bus" ] || { echo "the desktop is not up yet; try again in a moment" >&2; exit 3; }
exec runuser -u tester -- env XDG_RUNTIME_DIR="/run/user/$uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  systemd-run --user --quiet --collect sh -c "exec $cmd"
EOF
}

# Start the installed app in the running VM, as if clicked in its dock.
start_app_in_vm() {
  need python3
  [ -S "$QGA_SOCK" ] ||
    die "the running VM has no guest agent channel (started by an older fresh-vm.sh); close its window and run again"
  qga_exec /bin/sh -c "$(guest_launch)" ||
    die "could not start $APP_DISPLAY in the VM (a VM from an older base has no guest agent: scripts/fresh-vm.sh base --rebuild)"
  say "started $APP_DISPLAY in the running VM"
}

# The guest's side of a live update: $1 is the folder the host copied install.sh
# and pkg/<package> into. Installs it as root (the boot disc's install.sh, same
# stamp check), then quits the app that was running so the next step starts the
# new one. The installed package changed files under the running app; SIGTERM,
# then SIGKILL after 20 s.
guest_live_update() {
  cat <<'EOF'
set -eu
live=$1
trap 'rm -rf "$live"' EXIT
case $(systemctl show fresh-vm-install.service --property=ActiveState --value) in
  activating|deactivating) echo 'the boot installer is still running; try again once it finishes' >&2; exit 1 ;;
esac
state=/var/lib/fresh-vm
# What the running app is called, from the entry the previous install recorded.
old=
if entry=$(cat "$state/entry" 2>/dev/null) && [ -f "$entry" ]; then
  old=$(sed -n 's/^Exec=//p' "$entry" | head -n 1 | sed 's/ %[A-Za-z]//g' | cut -d' ' -f1)
fi

sh "$live/install.sh" "$live/pkg"

# tester's processes of the old app: by name (a .deb), or by the APPIMAGE
# variable the AppImage runtime sets for its app (an AppImage).
app_pids() {
  [ -n "$old" ] || return 0
  pgrep -u tester -x -- "$(basename "$old" | cut -c1-15)" || true
  case $old in
    /home/*)
      for p in /proc/[0-9]*; do
        if tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -qxF "APPIMAGE=$old"; then basename "$p"; fi
      done ;;
  esac
}
alive() {
  for p in $pids; do kill -0 "$p" 2>/dev/null && return 0; done
  return 1
}
pids=$(app_pids | sort -u)
if [ -n "$pids" ]; then
  echo "quitting the running app ($(echo $pids))"
  kill -TERM $pids 2>/dev/null || true
  i=0
  while [ "$i" -lt 40 ] && alive; do sleep 0.5; i=$((i + 1)); done
  alive && kill -KILL $pids 2>/dev/null || true
fi
echo "installed: $(cat "$state/installed")"
EOF
}

need() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "'$t' is not installed"; done
}

need_kvm() {
  [ -r /dev/kvm ] && [ -w /dev/kvm ] ||
    die "/dev/kvm is not usable here (run this on the host, outside an agent fence; the user must be in the 'kvm' group)"
}

# The ISO tool this machine has, as an mkisofs-compatible command line.
mkiso() {
  if command -v genisoimage >/dev/null 2>&1; then
    genisoimage "$@"
  elif command -v xorriso >/dev/null 2>&1; then
    xorriso -as mkisofs "$@"
  elif command -v mkisofs >/dev/null 2>&1; then
    mkisofs "$@"
  else
    die "need xorriso, genisoimage or mkisofs"
  fi
}

# --- base ------------------------------------------------------------------

# The guest's boot hook, baked into the base: if a disc labelled $PKG_LABEL
# is in the drive, run its install.sh (written per run by `package_disc`, so
# changing the install steps never needs a new base). Runs before the login
# screen, so the desktop comes up with the package already there.
boot_hook() {
  cat <<EOF
#!/bin/sh
set -eu
dev=/dev/disk/by-label/$PKG_LABEL
[ -e "\$dev" ] || exit 0
mnt=\$(mktemp -d)
mount -o ro "\$dev" "\$mnt"
trap 'umount "\$mnt"' EXIT
sh "\$mnt/install.sh" "\$mnt"
EOF
}

# Register the guest's display manager explicitly. A cloud image can have
# gdm3 fully installed without the display-manager.service alias; checking
# dpkg's status alone then accepts a base that boots to a text login.
# Emitted into both the bake and each package disc so old bases heal too.
# Do not start GDM here: the package hook runs Before=display-manager.service.
desktop_setup() {
  cat <<'EOF'
#!/bin/sh
set -eu

# Keep the VM's prewritten GDM config without a conffile prompt. Package
# scripts must not wait for GDM to start while our boot hook runs Before it.
# The subshell restores an existing service policy on success or failure.
apt_install() (
  work=$(mktemp -d)
  policy=/usr/sbin/policy-rc.d
  if [ -e "$policy" ] || [ -L "$policy" ]; then
    cp -a "$policy" "$work/original"
  fi
  trap 'rc=$?; rm -f "$policy"; if [ -e "$work/original" ] || [ -L "$work/original" ]; then mv "$work/original" "$policy"; fi; rm -rf "$work"; exit "$rc"' EXIT
  trap 'exit 1' HUP INT TERM
  printf '#!/bin/sh\nexit 101\n' > "$work/block"
  chmod 755 "$work/block"
  mv -f "$work/block" "$policy"
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
)

# Older images can contain unpacked but unconfigured desktop packages.
# Repair those before registration, including on an unchanged package stamp.
repair=0
for package in gdm3 ubuntu-desktop-minimal qemu-guest-agent; do
  [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)" = "ii " ] || repair=1
done
[ -z "$(dpkg --audit)" ] || repair=1
if [ "$repair" = 1 ]; then
  apt-get update
  apt_install --fix-broken ubuntu-desktop-minimal qemu-guest-agent
fi
[ -x /usr/sbin/gdm3 ] || { echo "the base has no gdm3 after desktop repair" >&2; exit 1; }
unit=$(systemctl show gdm3.service --property=FragmentPath --value)
[ -n "$unit" ] && [ -f "$unit" ] || { echo "the base has no GDM service unit; rebuild the base image" >&2; exit 1; }
mkdir -p /etc/X11 /etc/systemd/system
printf '/usr/sbin/gdm3\n' > /etc/X11/default-display-manager
printf 'gdm3 shared/default-x-display-manager select gdm3\n' | debconf-set-selections
ln -sfn "$unit" /etc/systemd/system/display-manager.service
systemctl daemon-reload
systemctl set-default graphical.target
# The headless bake has no agent device. Enable it for subsequent boots;
# with a channel present, recover its service after repairing the packages.
systemctl add-wants multi-user.target qemu-guest-agent.service
if [ -e /dev/virtio-ports/org.qemu.guest_agent.0 ]; then
  systemctl reset-failed qemu-guest-agent.service
  systemctl --no-block start qemu-guest-agent.service
fi
EOF
}

# The disc's install.sh: once per package (a stamp of its file name and hash), install
# a .deb with apt — Recommends included, as a user's `apt install` does, a
# downgrade allowed — or put an AppImage into the home folder in place of the
# ones placed before, with a launcher of its own. Either way the app is pinned
# to the dock and started at every login, so the one host call ends with it
# open.
install_script() {
  # Repair registration even when this package's stamp already matches.
  desktop_setup
  cat <<'EOF'
# An old image may have had no display-manager unit when graphical.target
# was queued. Enqueue it now without waiting on this Before= hook itself.
systemctl --no-block start display-manager.service
mnt="$1"
state=/var/lib/fresh-vm
mkdir -p "$state"
# The stamp is the file's name AND a hash of its content: a rebuild at the
# same version has the same name and must still be installed.
want=$(cd "$mnt" && for f in *; do
  [ "$f" = install.sh ] || printf '%s %s\n' "$f" "$(sha256sum "$f" | cut -c1-12)"
done)
[ "$(cat "$state/installed" 2>/dev/null)" = "$want" ] && exit 0

# Start the app of desktop entry $1 at login and pin it to the dock (system
# defaults: a dock the user rearranged by hand keeps their order).
present() {
  cp "$1" /etc/xdg/autostart/fresh-vm-launch.desktop
  printf '%s\n' "$1" > "$state/entry"
  cur=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || echo '[]')
  new=$(python3 -I -c 'import ast, sys
cur = ast.literal_eval(sys.argv[1].replace("@as ", ""))
print(repr([a for a in cur if a != sys.argv[2]] + [sys.argv[2]]))' "$cur" "$(basename "$1")")
  mkdir -p /etc/dconf/db/local.d
  printf '[org/gnome/shell]\nfavorite-apps=%s\n' "$new" > /etc/dconf/db/local.d/01-fresh-vm-dock
  dconf update
}

for f in "$mnt"/*.deb; do
  [ -e "$f" ] || continue
  cp "$f" /tmp/
  apt-get update
  # --reinstall: the same version rebuilt is otherwise "already newest".
  apt_install --allow-downgrades --reinstall "/tmp/$(basename "$f")"
  entry=$(dpkg -L "$(dpkg-deb -f "$f" Package)" | grep '^/usr/share/applications/.*\.desktop$' | head -n 1 || true)
  [ -z "$entry" ] || present "$entry"
done
for f in "$mnt"/*.AppImage; do
  [ -e "$f" ] || continue
  if [ -f "$state/appimages" ]; then
    while IFS= read -r old; do rm -f "/home/tester/$old"; done < "$state/appimages"
  fi
  install -o tester -g tester -m 0755 "$f" /home/tester/
  basename "$f" > "$state/appimages"
  entry=/usr/share/applications/fresh-vm-appimage.desktop
  printf '[Desktop Entry]\nType=Application\nName=%s\nExec=/home/tester/%s\nTerminal=false\n' \
    "$(basename "$f" .AppImage)" "$(basename "$f")" > "$entry"
  present "$entry"
done
printf '%s' "$want" > "$state/installed"
EOF
}

user_data() {
  cat <<EOF
#cloud-config
hostname: fresh
users:
  - name: tester
    gecos: Tester
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: false
chpasswd:
  expire: false
  users:
    - {name: tester, password: tester, type: text}
ssh_pwauth: false
package_update: true
write_files:
  - path: /usr/local/sbin/fresh-vm-install
    permissions: '0755'
    encoding: b64
    content: $(boot_hook | base64 -w0)
  - path: /usr/local/sbin/fresh-vm-desktop
    permissions: '0755'
    encoding: b64
    content: $(desktop_setup | base64 -w0)
  - path: /etc/systemd/system/fresh-vm-install.service
    content: |
      [Unit]
      Description=Install the package from the fresh-vm disc
      Wants=network-online.target
      After=network-online.target
      Before=display-manager.service
      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/fresh-vm-install
      StandardOutput=journal+console
      [Install]
      WantedBy=graphical.target
  - path: /etc/gdm3/custom.conf
    content: |
      [daemon]
      AutomaticLoginEnable=true
      AutomaticLogin=tester
  - path: /etc/dconf/profile/user
    content: |
      user-db:user
      system-db:local
  - path: /etc/dconf/db/local.d/00-fresh-vm
    content: |
      [org/gnome/desktop/screensaver]
      lock-enabled=false
      [org/gnome/desktop/session]
      idle-delay=uint32 0
runcmd:
  # gdm3 ships /etc/gdm3/custom.conf, written above: keep ours instead of
  # stopping at dpkg's conffile prompt (no stdin here, so gdm3 would be left
  # unconfigured and the desktop would boot to a text login).
  - DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ubuntu-desktop-minimal qemu-guest-agent
  - DEBIAN_FRONTEND=noninteractive apt-get purge -y gnome-initial-setup
  - dconf update
  - systemctl enable fresh-vm-install.service
  - /usr/local/sbin/fresh-vm-desktop
  - apt-get clean
  - touch /etc/cloud/cloud-init.disabled
  # runcmd goes on past a failed step: tell the host whether the desktop is
  # really there — installed and configured, logging in by itself (the marker
  # is computed so no echo of this line matches it).
  - '[ -x /usr/bin/gnome-shell ] && [ -x /usr/sbin/qemu-ga ] && [ "\$(dpkg-query -W -f=''\${db:Status-Abbrev}'' gdm3)" = "ii " ] && [ -z "\$(dpkg --audit)" ] && grep -qx "AutomaticLogin=tester" /etc/gdm3/custom.conf && [ "\$(systemctl show display-manager.service --property=LoadState --value)" = loaded ] && [ "\$(systemctl get-default)" = graphical.target ] && echo "BAKE-\$((40 + 2))-OK" > /dev/ttyS0'
power_state:
  mode: poweroff
  condition: true
EOF
}

cmd_base() {
  local rebuild=0
  [ "${1:-}" = "--rebuild" ] && rebuild=1
  need qemu-system-x86_64 qemu-img curl sha256sum
  need_kvm
  if [ -e "$BASE" ] && [ "$rebuild" = 0 ]; then
    say "base image already baked: $BASE (--rebuild to bake it again)"
    return
  fi
  if [ -e "$BASE" ]; then
    refuse_if_running
    # The VM is an overlay on the base; a new base invalidates it.
    [ -e "$VM" ] && say "--rebuild resets the VM too"
    rm -f "$VM" "$PKG_ISO" "$INSTALLED"
    chmod u+w "$BASE"
    rm -f "$BASE"
  fi
  mkdir -p "$DIR"

  say "fetching $CLOUD_IMG"
  curl -fL --retry 3 -o "$DIR/SHA256SUMS" "$CLOUD_URL/SHA256SUMS"
  if ! (cd "$DIR" && grep " \*\?$CLOUD_IMG\$" SHA256SUMS | sha256sum -c --quiet - >/dev/null 2>&1); then
    curl -fL --retry 3 -C - -o "$DIR/$CLOUD_IMG" "$CLOUD_URL/$CLOUD_IMG" || true
    (cd "$DIR" && grep " \*\?$CLOUD_IMG\$" SHA256SUMS | sha256sum -c --quiet -) ||
      { rm -f "$DIR/$CLOUD_IMG"; die "$CLOUD_IMG does not match its SHA256SUMS; run again"; }
  fi

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  local work="$WORK"
  user_data >"$work/user-data"
  printf 'instance-id: fresh-vm-base\nlocal-hostname: fresh\n' >"$work/meta-data"
  mkiso -quiet -V cidata -J -r -o "$work/seed.iso" "$work/user-data" "$work/meta-data"

  qemu-img convert -O qcow2 "$DIR/$CLOUD_IMG" "$BASE.part"
  qemu-img resize -q "$BASE.part" 32G

  say "baking the base image: cloud-init's progress follows; the VM powers itself off when done"
  notify "First start: building the VM's desktop (~15 min)" "Progress: $DIR/launcher.log"
  qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -smp "$CPUS" -m "$MEM" \
    -drive "file=$BASE.part,if=virtio,format=qcow2" \
    -drive "file=$work/seed.iso,media=cdrom,readonly=on" \
    -nic "$NIC" "${VIDEO[@]}" -nographic | tee "$work/bake.log"

  grep -q "BAKE-42-OK" "$work/bake.log" ||
    die "the bake did not finish (no desktop in the image); $BASE.part kept for a look; run the script again"
  mv "$BASE.part" "$BASE"
  # The VM is an overlay on it: it must never change again.
  chmod a-w "$BASE"
  say "base image ready: $BASE ($(du -h "$BASE" | cut -f1))"
}

# --- run -------------------------------------------------------------------

# Download the release's Linux package for VERSION ("latest" or "0.2.8") into
# the cache, check it, and print its path.
fetch_release() {
  local version="$1" api json tag dir asset url
  api="https://api.github.com/repos/$APP_REPO/releases"
  if [ "$version" = latest ]; then
    json="$(curl -fsSL "$api/latest")" || die "cannot read the latest release of $APP_REPO"
  else
    json="$(curl -fsSL "$api/tags/v${version#v}")" || die "no release v${version#v} in $APP_REPO"
  fi
  tag="$(jq -r .tag_name <<<"$json")"
  dir="$CACHE/$tag"
  # The desktop package; the server's (`<slug>-server_*.deb`) ships beside it.
  asset="$(jq -r --arg srv "$APP_SLUG-server_" \
    '[.assets[].name | select(endswith("_amd64.deb") and (ascii_downcase | startswith($srv) | not))][0] // empty' <<<"$json")"
  [ -n "$asset" ] || die "release $tag has no _amd64.deb"
  mkdir -p "$dir"
  if [ ! -s "$dir/$asset" ]; then
    url="$(jq -r --arg n "$asset" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$json")"
    say "downloading $asset" >&2
    curl -fL --retry 3 -o "$dir/$asset.part" "$url" >&2
    mv "$dir/$asset.part" "$dir/$asset"
  fi
  url="$(jq -r '.assets[] | select(.name == "SHA256SUMS") | .browser_download_url' <<<"$json")"
  if [ -n "$url" ]; then
    curl -fsSL -o "$dir/SHA256SUMS" "$url"
    (cd "$dir" && grep " \*\?$asset\$" SHA256SUMS | sha256sum -c --quiet -) ||
      { rm -f "$dir/$asset"; die "$asset does not match the release's SHA256SUMS"; }
  else
    say "release $tag has no SHA256SUMS; $asset is unchecked" >&2
  fi
  printf '%s\n' "$dir/$asset"
}

# The package disc for PKG: the package and its install.sh.
package_disc() {
  local work
  work="$(mktemp -d)"
  install_script >"$work/install.sh"
  ln -s "$1" "$work/$(basename "$1")"
  rm -f "$PKG_ISO"
  mkiso -quiet -f -V "$PKG_LABEL" -J -r -o "$PKG_ISO" "$work"
  rm -rf "$work"
}

# What the VM records for package FILE: its name and the head of its hash, the
# same text install.sh writes in the guest. The name alone cannot tell a rebuild
# at the same version from the package that is already there.
pkg_stamp() {
  printf '%s %s' "$(basename "$1")" "$(sha256sum "$1" | cut -c1-12)"
}

# The newest package built in this checkout (`tauri build --bundles
# appimage,deb`), by modification time. This script never builds one, and the
# frozen dev build (`npm run package:dev`) is a bare binary, not a package.
local_package() {
  local bundle="$ROOT/target/release/bundle" best version built commit ct hint=""
  best="$(ls -t "$bundle"/deb/*.deb "$bundle"/appimage/*.AppImage 2>/dev/null | head -n 1 || true)"
  if [ -z "$best" ]; then
    [ "$ROOT" != "$LAUNCHER" ] || hint=" (This is the desktop entry's copy of the script: run \`current\` from the checkout.)"
    die "no package built in this checkout under $bundle/{deb,appimage}.$hint
Build one (a few minutes; this script never starts a build): APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:bundle
The frozen dev build from 'npm run package:dev' is a bare binary and cannot be installed in the VM."
  fi
  version=""
  case "$best" in
    *.deb) version="$(dpkg-deb -f "$best" Version 2>/dev/null || true)" ;;
  esac
  built="$(date -d "@$(stat -c %Y "$best")" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
  commit="$(dev_git -C "$ROOT" log -1 --format='%h %ct' HEAD 2>/dev/null || true)"
  say "current build: $best" >&2
  say "  version ${version:-unknown}, built $built; checkout HEAD ${commit%% *}" >&2
  ct="${commit##* }"
  if [ -n "$commit" ] && [ "$(stat -c %Y "$best")" -lt "$ct" ] 2>/dev/null; then
    say "  note: the package is older than the checkout's last commit; rebuild it for the latest changes" >&2
  fi
  printf '%s\n' "$best"
}

# The package for WHAT ("latest", a version, `current`, a file; empty: none),
# printed as a path.
resolve_package() {
  local what="$1"
  if [ -z "$what" ]; then
    return 0
  elif [ "$what" = current ]; then
    need sha256sum
    local_package
  elif [ -f "$what" ]; then
    case "$what" in
      *.deb | *.AppImage) ;;
      *) die "$what is neither a .deb nor an .AppImage" ;;
    esac
    realpath "$what"
  else
    need curl jq sha256sum
    fetch_release "$what"
  fi
}

# The package stamp the running guest holds (empty when nothing is installed).
# Return 69 when the guest agent does not answer.
guest_stamp() {
  qga_exec --timeout 15 /bin/sh -c 'cat /var/lib/fresh-vm/installed 2>/dev/null || true'
}

# The guest agent is not there, or does not answer: say why and what to do.
no_agent_message() {
  die "the VM is running but its guest agent does not answer (it is still booting, the base has no agent: scripts/fresh-vm.sh base --rebuild, or the VM was started by an older script). Nothing was changed. Wait a minute and run again, or close the VM window and run again: a stopped VM installs the package at boot, without the agent"
}

# Update the RUNNING VM in place: copy the package into the guest through the
# agent, install it there as root, quit and restart the app as tester. WHAT is
# resolved by resolve_package; empty only starts the app.
update_running_vm() {
  local what="$1" pkg stamp have rc=0 live=/var/tmp/fresh-vm-live sum guest_sum tmp
  need python3
  [ -S "$QGA_SOCK" ] ||
    die "the running VM has no guest agent channel (it was started by an older fresh-vm.sh). Nothing was changed: close its window and run again; a stopped VM installs the package at boot"
  pkg="$(resolve_package "$what")"
  say "asking the running VM what it has installed"
  have="$(guest_stamp)" || rc=$?
  [ "$rc" = 0 ] || { [ "$rc" = 69 ] && no_agent_message; die "the guest agent failed (exit $rc); see the output above"; }
  if [ -z "$pkg" ]; then
    say "installed in the VM: ${have:-nothing}"
    start_app_in_vm
    return
  fi
  stamp="$(pkg_stamp "$pkg")"
  if [ "$have" = "$stamp" ]; then
    say "this package is already installed in the VM ($stamp); nothing to copy"
    start_app_in_vm
    return
  fi
  say "updating the running VM: ${have:-nothing} -> $stamp (its state is kept)"
  tmp="$(mktemp -d)"
  install_script >"$tmp/install.sh"
  sum="$(sha256sum "$pkg" | cut -d' ' -f1)"
  qga_exec /bin/sh -c 'rm -rf "$1" && mkdir -p "$1/pkg"' sh "$live" ||
    { rm -rf "$tmp"; die "could not prepare $live in the VM"; }
  qga_exec --timeout 60 --put "$tmp/install.sh" "$live/install.sh" ||
    { rm -rf "$tmp"; die "could not copy the installer into the VM"; }
  rm -rf "$tmp"
  say "copying $(basename "$pkg") ($(du -h "$pkg" | cut -f1)) into the VM"
  qga_exec --timeout 120 --put "$pkg" "$live/pkg/$(basename "$pkg")" ||
    die "could not copy the package into the VM; nothing was installed"
  guest_sum="$(qga_exec --timeout 300 /bin/sh -c 'sha256sum "$1"' sh "$live/pkg/$(basename "$pkg")" | cut -d' ' -f1)" || true
  [ "$guest_sum" = "$sum" ] ||
    die "the copy in the VM does not match the package (${guest_sum:-no checksum}); nothing was installed, run again"
  say "installing in the VM; the guest's output follows when it finishes (up to 30 min)"
  rc=0
  qga_exec --timeout 1800 /bin/sh -c "$(guest_live_update)" sh "$live" || rc=$?
  if [ "$rc" != 0 ]; then
    die "installing in the running VM failed (exit $rc, output above). The running app was not restarted; close the VM window and run again to install at boot"
  fi
  printf '%s\n' "$stamp" >"$INSTALLED"
  start_app_in_vm
}

new_vm() {
  rm -f "$VM" "$PKG_ISO" "$INSTALLED"
  qemu-img create -q -f qcow2 -b "$BASE" -F qcow2 "$VM"
}

# cmd_run [--fresh] [WHAT]: WHAT is a version, `latest`, `current`, a package
# file, or empty for a boot that installs nothing. A VM that is there is only
# UPDATED (running: live through the guest agent; stopped: at boot); only
# --fresh, or no VM yet, makes a new one.
cmd_run() {
  local fresh=0 what="" pkg="" disc=()
  if [ "${1:-}" = "--fresh" ]; then fresh=1; shift; fi
  what="${1:-}"
  if [ "$fresh" = 0 ] && vm_running; then
    update_running_vm "$what"
    return
  fi
  pkg="$(resolve_package "$what")" # before anything is deleted
  if vm_running; then
    if [ "$(confirm_fresh_running)" != yes ]; then
      say "left the running VM as it is"
      return
    fi
    stop_vm
    refuse_if_running
  fi
  need qemu-system-x86_64 qemu-img
  need_kvm
  if [ "$fresh" = 1 ] || [ ! -e "$VM" ]; then
    [ -e "$BASE" ] || cmd_base
    new_vm
    say "clean VM"
  else
    say "updating the VM that is there; its state is kept (--fresh for a clean desktop)"
  fi
  if [ -n "$pkg" ]; then
    package_disc "$pkg"
    pkg_stamp "$pkg" >"$INSTALLED"
    printf '\n' >>"$INSTALLED"
    say "this boot installs $(basename "$pkg") before the desktop appears (skipped if the VM already has this exact package)"
    disc=(-drive "file=$PKG_ISO,media=cdrom,readonly=on")
  else
    say "installed: $(cat "$INSTALLED" 2>/dev/null || echo nothing)"
  fi

  say "guest login: tester / tester; boot log: $DIR/serial.log"
  say "close the QEMU window (or power off inside the VM) to stop it"
  rm -f "$QGA_SOCK"
  qemu-system-x86_64 \
    -name "$APP_DISPLAY fresh VM (login: tester / tester)" \
    -machine q35,accel=kvm -cpu host -smp "$CPUS" -m "$MEM" \
    -drive "file=$VM,if=virtio,format=qcow2" \
    "${disc[@]}" \
    -nic "$NIC" \
    -chardev "socket,id=qga0,path=$QGA_SOCK,server=on,wait=off" \
    -device virtio-serial-pci -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
    "${VIDEO[@]}" -display gtk \
    -serial "file:$DIR/serial.log" \
    -device qemu-xhci -device usb-tablet
}

# Repair a running guest from a host terminal: no typing in QEMU's console,
# no new disk and no VM restart. The package output is returned by the agent.
guest_repair() {
  cat <<'EOF'
#!/bin/sh
set -eu
case $(systemctl show fresh-vm-install.service --property=ActiveState --value) in
  activating|deactivating) echo 'the boot installer is still running; try repair once it finishes' >&2; exit 1 ;;
esac
EOF
  desktop_setup
  cat <<'EOF'
systemctl reset-failed display-manager.service
if ! systemctl start display-manager.service; then
  systemctl --no-pager -l status display-manager.service || true
  journalctl -b -u gdm.service -u gdm3.service --no-pager -n 40
  exit 1
fi
systemctl --no-pager -l status display-manager.service
EOF
}

cmd_repair() {
  need python3
  vm_running || die "the VM is not running; open it first"
  [ -S "$QGA_SOCK" ] || die "the running VM has no guest agent channel; power it off and run this script again to repair at boot"
  say "repairing the running VM's desktop; package output follows when finished (up to 15 min)"
  local rc=0
  qga_exec --timeout 900 /bin/sh -c "$(guest_repair)" || rc=$?
  if [ "$rc" = 69 ]; then
    die "the guest agent is unavailable, so live repair could not start. Close the QEMU window yourself, then run: bash '$ROOT/scripts/fresh-vm.sh' latest — it updates the same VM; the package disc repairs the desktop at boot without the guest agent"
  fi
  [ "$rc" = 0 ] || die "desktop repair failed; see the guest output above"
  say "desktop repair finished; check the QEMU window"
}

# --- status / reset --------------------------------------------------------

cmd_status() {
  local stamp rc=0
  if [ -e "$BASE" ]; then
    printf 'base       %s\n' "$(du -h "$BASE" | cut -f1)"
  else
    echo "no base image (scripts/fresh-vm.sh base)"
    return
  fi
  if [ ! -e "$VM" ]; then
    echo "vm         none yet (scripts/fresh-vm.sh [<version>])"
    return
  fi
  printf 'vm         %s\n' "$(du -h "$VM" | cut -f1)"
  if ! vm_running; then
    printf 'state      stopped\n'
    printf 'installed  %s\n' "$(cat "$INSTALLED" 2>/dev/null || echo nothing)"
    return
  fi
  printf 'state      running\n'
  if [ ! -S "$QGA_SOCK" ] || ! command -v python3 >/dev/null 2>&1; then
    printf 'installed  %s (last recorded by the host; no guest agent channel to ask)\n' \
      "$(cat "$INSTALLED" 2>/dev/null || echo nothing)"
    return
  fi
  stamp="$(guest_stamp 2>/dev/null)" || rc=$?
  if [ "$rc" = 0 ]; then
    printf 'installed  %s (asked of the running VM)\n' "${stamp:-nothing}"
  else
    printf 'installed  %s (last recorded by the host; the VM is running but its guest agent does not answer: still booting, or no agent in this base)\n' \
      "$(cat "$INSTALLED" 2>/dev/null || echo nothing)"
  fi
}

cmd_reset() {
  [ -e "$BASE" ] || die "nothing to reset yet: scripts/fresh-vm.sh builds it"
  need qemu-img
  refuse_if_running
  new_vm
  say "the VM is a clean desktop again"
}

# --- desktop entry ---------------------------------------------------------

# What the installed copy needs, relative to a checkout.
launcher_files() {
  printf '%s\n' \
    scripts/fresh-vm.sh \
    scripts/lib/brand.sh \
    scripts/lib/dev-launcher.sh \
    src-core/src/brand.rs \
    src-tauri/Cargo.toml \
    src-tauri/icons/128x128.png
}

# Copy this script (and what it sources) to $LAUNCHER, swapped in whole, and
# write the desktop entry that runs the copy. Only from the checkout and only
# on the host: inside a fence $HOME is the agent's own.
install_launcher() {
  local tmp="$LAUNCHER.tmp.$$" file
  [ "$ROOT" != "$LAUNCHER" ] || return 0
  mkdir -p "$DIR"
  dev_on_host "$DIR" || return 0
  rm -rf "$tmp"
  while IFS= read -r file; do
    [ -f "$ROOT/$file" ] && [ ! -L "$ROOT/$file" ] || { rm -rf "$tmp"; return 1; }
    mkdir -p "$tmp/$(dirname "$file")" && cp "$ROOT/$file" "$tmp/$file" || { rm -rf "$tmp"; return 1; }
  done < <(launcher_files)
  chmod -R u+rwX,go-w "$tmp"
  chmod 755 "$tmp/scripts/fresh-vm.sh"
  rm -rf "$LAUNCHER.old"
  if [ -e "$LAUNCHER" ]; then mv "$LAUNCHER" "$LAUNCHER.old"; fi
  mv "$tmp" "$LAUNCHER"
  rm -rf "$LAUNCHER.old"

  mkdir -p "$DESKTOP_DIR"
  cat >"$DESKTOP_ENTRY.tmp" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_DISPLAY (VM)
Comment=A fresh Ubuntu desktop with the latest $APP_DISPLAY release
Exec=$(dev_desktop_quote "$LAUNCHER/scripts/fresh-vm.sh") --from-desktop
Icon=$LAUNCHER/src-tauri/icons/128x128.png
Terminal=false
Categories=Development;
DESKTOP
  chmod 755 "$DESKTOP_ENTRY.tmp"
  mv -f "$DESKTOP_ENTRY.tmp" "$DESKTOP_ENTRY"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi

  # The same entry as a desktop icon. Ubuntu's desktop runs only an
  # executable entry marked trusted; without that it shows a dead icon.
  local desk icon
  desk="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  [ -n "$desk" ] || desk="$HOME/Desktop"
  if [ -d "$desk" ] && [ "$desk" != "$HOME" ]; then
    icon="$desk/$(basename "$DESKTOP_ENTRY")"
    cp -f "$DESKTOP_ENTRY" "$icon.tmp" && chmod 755 "$icon.tmp" && mv -f "$icon.tmp" "$icon"
    if command -v gio >/dev/null 2>&1; then
      gio set "$icon" metadata::trusted true >/dev/null 2>&1 || true
    fi
  fi
}

if [ "${1:-}" = "--from-desktop" ]; then
  shift
  FROM_DESKTOP=1
  mkdir -p "$DIR"
  exec >"$DIR/launcher.log" 2>&1
  # A failure that is not a `die` gets a notification too.
  set -E
  trap 'notify -u critical "$APP_DISPLAY (VM) failed" "See $DIR/launcher.log"' ERR
fi
install_launcher || say "could not install the desktop entry; the VM runs anyway"

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  base) cmd_base "$@" ;;
  boot) cmd_run ;;
  repair) cmd_repair ;;
  run) exec "${BASH_SOURCE[0]}" "$@" ;; # the earlier spelling
  status) cmd_status ;;
  reset) cmd_reset ;;
  help | -h | --help) sed -n '3,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" ;;
  --fresh) cmd_run --fresh "${1:-latest}" ;;
  *) cmd_run "${sub:-latest}" ;;
esac
