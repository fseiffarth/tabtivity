#!/usr/bin/env bash
#
# A server VM: the multi-user server set up the way docs/guide/server.md says,
# in a headless Ubuntu 24.04 VM that joins your tailnet, so a browser or a
# phone on the tailnet signs in to it like to a real server. The sibling of
# scripts/fresh-vm.sh (the desktop seen by a brand-new user); this one is for
# trying and updating the server, not for hosting it — it does not start
# again after a host reboot (a real server: a dedicated machine or libvirt).
#
# Run it on the host, outside an agent fence (it needs /dev/kvm). It never
# touches libvirt, the running Tabtivity or its state.
#
#   scripts/server-vm.sh <size> [--disk GB] [latest|<version>|file.deb|--build]
#       the one call: builds the base image if there is none yet (once,
#       ~5 min), boots the VM in the background at that size, installs that
#       server package (default: latest; --build packs this checkout with
#       scripts/package-server-deb.sh), and on the first run does the guide's
#       steps 4–7: the VM joins your tailnet, the services are installed,
#       the /proc line goes into fstab, Tailscale Serve publishes 443/8443,
#       `check` runs, and you are added as admin. Ends with the URL and a
#       pairing code. Later calls install over it, up or down; the package
#       restarts the services, agents keep running.
#
#       size   RAM     CPUs  disk
#       small  4 GiB   2     40 GB    trying it out, 1–2 users
#       medium 8 GiB   4     80 GB    a few users with agents
#       large  16 GiB  6     160 GB   the guide's size; local models on CPU
#       --disk GB overrides the disk, up to 500. The disk is sparse (it takes
#       host space only as the server fills it) and only ever grows: a larger
#       --disk later grows it, a smaller one is refused. RAM and CPUs follow
#       the size of each start.
#
#   scripts/server-vm.sh start              boot (last size), install nothing
#   scripts/server-vm.sh stop               shut the VM down
#   scripts/server-vm.sh ssh [command…]     a shell on the VM (user `ops`, sudo)
#   scripts/server-vm.sh invite             a new pairing code for you
#   scripts/server-vm.sh status             running?, size, package, URL
#   scripts/server-vm.sh reset              back to a clean Ubuntu: the server,
#                                           its users and projects are gone
#   scripts/server-vm.sh base --rebuild     build the base image again
#
# The tailnet: the VM is a machine of its own there (`<slug>-server-vm`).
# MagicDNS and HTTPS Certificates must be on (the guide's "What you need").
# With <PREFIX>SERVER_VM_TS_AUTHKEY set to an auth key it joins by itself;
# otherwise the first run prints a login link to open once. After a reset,
# remove the old machine in the Tailscale admin console.
#
# Release packages are checked against the release's SHA256SUMS and its
# signature (src-tauri/release-signing.pub.pem).
#
# Files: ~/.local/share/<slug>-server-vm (override: <PREFIX>SERVER_VM_DIR).
# SSH port on the host's loopback: <PREFIX>SERVER_VM_SSH_PORT (2242).
# Your server user name: <PREFIX>SERVER_VM_USER (default: $USER).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_REPO, …
. "$ROOT/scripts/lib/brand.sh"

DIR="$(app_env SERVER_VM_DIR "$HOME/.local/share/$APP_SLUG-server-vm")"
SSH_PORT="$(app_env SERVER_VM_SSH_PORT 2242)"
CLOUD_URL="https://cloud-images.ubuntu.com/noble/current"
CLOUD_IMG="noble-server-cloudimg-amd64.img"
BASE="$DIR/base.qcow2"
VM="$DIR/vm.qcow2"
KEY="$DIR/ssh_key"
PIDFILE="$DIR/qemu.pid"
CONSOLE="$DIR/console.log"
SIZE_FILE="$DIR/size"
CACHE="$DIR/packages"
# User-mode NAT, the guest's SSH forwarded to the host's loopback only. A
# fixed MAC keeps the netplan config cloud-init wrote at bake time matching.
NIC="user,model=virtio-net-pci,mac=52:54:00:4e:f0:02,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22"
TS_NAME="$APP_SLUG-server-vm"
HELPER="/usr/lib/$APP_SLUG/$APP_SLUG-admin-helper"
MAX_DISK=500
WORK=""
trap 'if [ -n "$WORK" ]; then rm -rf "$WORK"; fi' EXIT

die() { printf 'server-vm: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }

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

# size → "MiB CPUs diskGB"
size_spec() {
  case "$1" in
    small) echo "4096 2 40" ;;
    medium) echo "8192 4 80" ;;
    large) echo "16384 6 160" ;;
    *) return 1 ;;
  esac
}

# The QEMU of this VM, by its pid file: never `pgrep -f`, which matches its
# own command line.
running_pid() {
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF "file=$VM," || return 1
  echo "$pid"
}

vm_ssh() {
  ssh -i "$KEY" -p "$SSH_PORT" \
    -o UserKnownHostsFile="$DIR/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o LogLevel=ERROR -o ConnectTimeout=5 ops@127.0.0.1 "$@"
}

wait_for_ssh() {
  local deadline=$((SECONDS + 240))
  until vm_ssh true 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die "the VM did not answer on SSH within 4 minutes (console: $CONSOLE)"
    sleep 3
  done
}

# --- base ------------------------------------------------------------------

user_data() {
  cat <<EOF
#cloud-config
hostname: $APP_SLUG-server
users:
  - name: ops
    gecos: Server VM operator
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$KEY.pub")
ssh_pwauth: false
package_update: true
packages: [jq, openssl, cloud-guest-utils]
runcmd:
  - curl -fsSL https://tailscale.com/install.sh | sh
  - apt-get clean
  - touch /etc/cloud/cloud-init.disabled
  # runcmd goes on past a failed step: tell the host whether Tailscale is
  # really there (the marker is computed so no echo of this line matches it).
  - '[ -x /usr/bin/tailscale ] && echo "BAKE-\$((40 + 2))-OK" > /dev/ttyS0'
power_state:
  mode: poweroff
  condition: true
EOF
}

cmd_base() {
  local rebuild=0
  [ "${1:-}" = "--rebuild" ] && rebuild=1
  need qemu-system-x86_64 qemu-img curl sha256sum ssh-keygen
  need_kvm
  if [ -e "$BASE" ] && [ "$rebuild" = 0 ]; then
    say "base image already baked: $BASE (--rebuild to bake it again)"
    return
  fi
  if [ -e "$BASE" ]; then
    running_pid >/dev/null && die "the VM is running; stop it first"
    # The VM is an overlay on the base; a new base invalidates it.
    [ -e "$VM" ] && say "--rebuild resets the VM too"
    rm -f "$VM" "$SIZE_FILE" "$DIR/known_hosts"
    chmod u+w "$BASE"
    rm -f "$BASE"
  fi
  mkdir -p "$DIR"
  [ -e "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$TS_NAME" -f "$KEY"

  say "fetching $CLOUD_IMG"
  curl -fL --retry 3 -o "$DIR/SHA256SUMS" "$CLOUD_URL/SHA256SUMS"
  if ! (cd "$DIR" && grep " \*\?$CLOUD_IMG\$" SHA256SUMS | sha256sum -c --quiet - >/dev/null 2>&1); then
    curl -fL --retry 3 -C - -o "$DIR/$CLOUD_IMG" "$CLOUD_URL/$CLOUD_IMG" || true
    (cd "$DIR" && grep " \*\?$CLOUD_IMG\$" SHA256SUMS | sha256sum -c --quiet -) ||
      { rm -f "$DIR/$CLOUD_IMG"; die "$CLOUD_IMG does not match its SHA256SUMS; run again"; }
  fi

  WORK="$(mktemp -d)"
  local work="$WORK"
  user_data >"$work/user-data"
  printf 'instance-id: server-vm-base\nlocal-hostname: %s-server\n' "$APP_SLUG" >"$work/meta-data"
  mkiso -quiet -V cidata -J -r -o "$work/seed.iso" "$work/user-data" "$work/meta-data"

  qemu-img convert -O qcow2 "$DIR/$CLOUD_IMG" "$BASE.part"
  qemu-img resize -q "$BASE.part" 12G

  say "baking the base image: cloud-init's progress follows; the VM powers itself off when done"
  qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -smp 2 -m 2048 \
    -drive "file=$BASE.part,if=virtio,format=qcow2" \
    -drive "file=$work/seed.iso,media=cdrom,readonly=on" \
    -nic "$NIC" -nographic | tee "$work/bake.log"

  grep -q "BAKE-42-OK" "$work/bake.log" ||
    die "the bake did not finish (no Tailscale in the image); $BASE.part kept for a look; run the script again"
  mv "$BASE.part" "$BASE"
  # The VM is an overlay on it: it must never change again.
  chmod a-w "$BASE"
  say "base image ready: $BASE ($(du -h "$BASE" | cut -f1))"
}

# --- packages --------------------------------------------------------------

# Download the release's server package for VERSION ("latest" or "0.2.8")
# into the cache, check it against the signed SHA256SUMS, print its path.
fetch_release() {
  local version="$1" api json tag dir asset url
  need curl jq sha256sum openssl
  api="https://api.github.com/repos/$APP_REPO/releases"
  if [ "$version" = latest ]; then
    json="$(curl -fsSL "$api/latest")" || die "cannot read the latest release of $APP_REPO"
  else
    json="$(curl -fsSL "$api/tags/v${version#v}")" || die "no release v${version#v} in $APP_REPO"
  fi
  tag="$(jq -r .tag_name <<<"$json")"
  asset="$(jq -r --arg srv "$APP_SLUG-server_" \
    '[.assets[].name | select((ascii_downcase | startswith($srv)) and endswith("_amd64.deb"))][0] // empty' <<<"$json")"
  [ -n "$asset" ] || die "release $tag has no server package (releases carry one from the first after it was added); use --build or a .deb"
  dir="$CACHE/$tag"
  mkdir -p "$dir"
  for f in SHA256SUMS SHA256SUMS.sig "$asset"; do
    [ "$f" != "$asset" ] || [ ! -s "$dir/$f" ] || continue
    url="$(jq -r --arg n "$f" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$json")"
    [ -n "$url" ] || die "release $tag has no $f"
    [ "$f" = "$asset" ] && say "downloading $asset" >&2
    curl -fsSL --retry 3 -o "$dir/$f.part" "$url"
    mv "$dir/$f.part" "$dir/$f"
  done
  openssl dgst -sha256 -verify "$ROOT/src-tauri/release-signing.pub.pem" \
    -signature "$dir/SHA256SUMS.sig" "$dir/SHA256SUMS" >/dev/null ||
    die "release $tag: SHA256SUMS does not carry the release signature"
  (cd "$dir" && grep " \*\?$asset\$" SHA256SUMS | sha256sum -c --quiet -) ||
    { rm -f "$dir/$asset"; die "$asset does not match the release's SHA256SUMS"; }
  printf '%s\n' "$dir/$asset"
}

# This checkout, packed by scripts/package-server-deb.sh.
build_package() {
  local out="$CACHE/build"
  rm -rf "$out"
  "$ROOT/scripts/package-server-deb.sh" --out "$out" >&2
  set -- "$out"/*.deb
  [ -f "$1" ] || die "package-server-deb.sh made no .deb"
  printf '%s\n' "$1"
}

install_package() {
  local pkg="$1" name
  name="$(basename "$pkg")"
  say "installing $name"
  vm_ssh "cat > /tmp/$name" <"$pkg"
  vm_ssh "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades /tmp/$name && rm -f /tmp/$name"
  vm_ssh "printf '%s\n' '$name' | sudo tee /var/lib/server-vm-package >/dev/null"
}

# --- setup (the guide's steps 4–7, once; each part skipped when done) -------

server_user() {
  local u
  u="$(app_env SERVER_VM_USER "${USER:-admin}")"
  u="$(printf '%s' "$u" | tr 'A-Z-' 'a-z_' | tr -cd 'a-z0-9_')"
  [ -n "$u" ] || die "no usable server user name; set $(app_env_name SERVER_VM_USER)"
  printf '%s\n' "$u"
}

app_env_name() { printf '%s%s\n' "$APP_ENV_PREFIX" "$1"; }

setup_script() {
  cat <<EOF
set -eu
st=/var/lib/server-vm
mkdir -p "\$st"
helper=$HELPER

if ! tailscale status >/dev/null 2>&1; then
  if [ -s /run/server-vm-tskey ]; then
    tailscale up --hostname=$TS_NAME --auth-key=file:/run/server-vm-tskey
  else
    echo "==> Join the VM to your tailnet: open the link below and log in."
    tailscale up --hostname=$TS_NAME
  fi
fi
rm -f /run/server-vm-tskey
host=\$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.\$//')
[ -n "\$host" ] && [ "\$host" != null ] || { echo "no tailnet name (is MagicDNS on?)" >&2; exit 1; }
echo "\$host" > "\$st/host"

# The guide's check fixes: ptrace scope, and user namespaces for the agent
# sandbox (Ubuntu 24.04 blocks them by default).
printf 'kernel.yama.ptrace_scope=1\n' > /etc/sysctl.d/60-$APP_SLUG.conf
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' > /etc/sysctl.d/60-$APP_SLUG-userns.conf
sysctl --system >/dev/null

if [ ! -e "\$st/installed" ]; then
  # No `| tee`: sh has no pipefail, and a failed install must not count as done.
  if "\$helper" install --origin "https://\$host" --content-origin "https://\$host:8443" >"\$st/install.log" 2>&1; then
    cat "\$st/install.log"
    touch "\$st/installed"
  else
    cat "\$st/install.log"
    exit 1
  fi
fi

line=\$(sed -n 's/^[[:space:]]*\(proc \/proc proc .*hidepid=.*\)\$/\1/p' "\$st/install.log" | tail -n 1)
if [ -n "\$line" ] && ! grep -qxF "\$line" /etc/fstab; then
  sed -i '/^proc[[:space:]]/d' /etc/fstab
  printf '%s\n' "\$line" >> /etc/fstab
  mount -o remount /proc
fi

tailscale serve --bg --https=443 http://127.0.0.1:8740 >/dev/null
tailscale serve --bg --https=8443 http://127.0.0.1:8741 >/dev/null

echo "==> $APP_SLUG-admin-helper check"
"\$helper" check || echo "==> check reported FAIL lines (above)"

if [ ! -e "\$st/user" ]; then
  "\$helper" user-add $1 --admin
  touch "\$st/user"
fi
EOF
}

setup() {
  local user key
  user="$(server_user)"
  key="$(app_env SERVER_VM_TS_AUTHKEY "")"
  if [ -n "$key" ]; then
    printf '%s' "$key" | vm_ssh "sudo install -m 0600 /dev/stdin /run/server-vm-tskey"
  fi
  setup_script "$user" | vm_ssh "sudo sh -s"
}

disk_gb() {
  local bytes
  bytes="$(qemu-img info --force-share --output=json "$VM" | jq -r '.["virtual-size"]')"
  echo $((bytes / 1024 / 1024 / 1024))
}

# The disk grows to WANT GB when it is smaller, never shrinks: a smaller
# --disk (EXPLICIT=1) is refused, a smaller size's default is just kept.
grow_disk() {
  local want="$1" explicit="$2" have
  have="$(disk_gb)"
  if [ "$want" -lt "$have" ]; then
    [ "$explicit" = 0 ] || die "the disk is ${have} GB; it never shrinks (reset for a smaller one)"
  elif [ "$want" -gt "$have" ]; then
    running_pid >/dev/null && die "growing the disk to ${want} GB needs the VM stopped: $0 stop"
    say "growing the disk from ${have} GB to ${want} GB"
    qemu-img resize -q "$VM" "${want}G"
  fi
}

boot() {
  local mem="$1" cpus="$2"
  : >"$CONSOLE"
  qemu-system-x86_64 \
    -name "$APP_DISPLAY server VM" \
    -machine q35,accel=kvm -cpu host -smp "$cpus" -m "$mem" \
    -drive "file=$VM,if=virtio,format=qcow2" \
    -nic "$NIC" \
    -display none -serial "file:$CONSOLE" \
    -daemonize -pidfile "$PIDFILE"
  say "booting (console: $CONSOLE)"
  wait_for_ssh
  # The root filesystem fills the disk, however large it has grown.
  vm_ssh 'dev=$(findmnt -no SOURCE /); sudo growpart "${dev%%[0-9]*}" "${dev##*[!0-9]}" >/dev/null 2>&1 || true; sudo resize2fs "$dev" >/dev/null 2>&1 || true'
}

show_access() {
  local host
  host="$(vm_ssh 'cat /var/lib/server-vm/host 2>/dev/null' || true)"
  [ -n "$host" ] || return 0
  say "open https://$host/ on a device on your tailnet (desktop interface: https://$host/desktop/)"
}

# --- commands --------------------------------------------------------------

cmd_up() {
  local size="$1"; shift
  local disk="" disk_given=0 what="latest" spec mem cpus pkg="" avail
  spec="$(size_spec "$size")" || die "size is small, medium or large, not '$size'"
  read -r mem cpus disk <<<"$spec"
  while [ $# -gt 0 ]; do
    case "$1" in
      --disk)
        [ $# -ge 2 ] || die "--disk needs a size in GB"
        disk="$(printf '%s' "$2" | sed 's/[Gg][Bb]\{0,1\}$//')"; disk_given=1; shift ;;
      --build) what="--build" ;;
      -*) die "unknown option $1" ;;
      *) what="$1" ;;
    esac
    shift
  done
  [[ "$disk" =~ ^[0-9]+$ ]] || die "--disk takes whole GB, not '$disk'"
  [ "$disk" -ge 20 ] && [ "$disk" -le "$MAX_DISK" ] || die "--disk is 20 to $MAX_DISK GB"
  need qemu-system-x86_64 qemu-img ssh jq
  need_kvm

  case "$what" in
    --build) pkg="$(build_package)" ;;
    *.deb) [ -f "$what" ] || die "no such file: $what"; pkg="$(realpath "$what")" ;;
    *) pkg="$(fetch_release "$what")" ;;
  esac

  [ -e "$BASE" ] || cmd_base
  if [ ! -e "$VM" ]; then
    qemu-img create -q -f qcow2 -b "$BASE" -F qcow2 "$VM" "${disk}G"
    say "new VM, ${disk} GB disk"
  else
    grow_disk "$disk" "$disk_given"
  fi
  avail="$(df -BG --output=avail "$DIR" | tail -n 1 | tr -dc 0-9)"
  [ "${avail:-0}" -ge "$disk" ] ||
    say "note: the host has ${avail} GB free where the disk lives; the disk takes space only as the server fills it"
  echo "$size" >"$SIZE_FILE"

  if running_pid >/dev/null; then
    say "the VM is running: installing into it (the size's RAM and CPUs apply from the next start)"
  else
    boot "$mem" "$cpus"
  fi
  install_package "$pkg"
  setup
  show_access
  say "stop it with: $0 stop"
}

cmd_start() {
  local size spec mem cpus _disk
  [ -e "$VM" ] || die "no VM yet: $0 <small|medium|large> creates it"
  running_pid >/dev/null && die "the VM is already running"
  need qemu-system-x86_64 ssh
  need_kvm
  size="$(cat "$SIZE_FILE" 2>/dev/null || echo small)"
  spec="$(size_spec "$size")"
  read -r mem cpus _disk <<<"$spec"
  boot "$mem" "$cpus"
  show_access
}

cmd_stop() {
  local pid deadline
  pid="$(running_pid)" || { say "the VM is not running"; return 0; }
  vm_ssh 'sudo systemctl poweroff' 2>/dev/null || true
  deadline=$((SECONDS + 90))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "no shutdown after 90 s; stopping QEMU"
      kill "$pid" 2>/dev/null || true
      break
    fi
    sleep 2
  done
  rm -f "$PIDFILE"
  say "stopped"
}

cmd_status() {
  if [ ! -e "$BASE" ]; then
    echo "no base image yet ($0 <size> builds it)"
    return
  fi
  printf 'base       %s\n' "$(du -h "$BASE" | cut -f1)"
  if [ ! -e "$VM" ]; then
    echo "vm         none yet ($0 <small|medium|large>)"
    return
  fi
  printf 'vm         %s used of %s GB, size %s\n' "$(du -h "$VM" | cut -f1)" "$(disk_gb)" "$(cat "$SIZE_FILE" 2>/dev/null || echo '?')"
  if running_pid >/dev/null; then
    printf 'running    yes (ssh: %s ssh)\n' "$0"
    printf 'package    %s\n' "$(vm_ssh 'cat /var/lib/server-vm-package 2>/dev/null' || echo '?')"
    show_access
  else
    echo "running    no ($0 start)"
  fi
}

cmd_invite() {
  running_pid >/dev/null || die "the VM is not running ($0 start)"
  vm_ssh "sudo $HELPER invite $(server_user)"
}

cmd_reset() {
  [ -e "$BASE" ] || die "nothing to reset yet"
  running_pid >/dev/null && die "the VM is running; stop it first"
  rm -f "$VM" "$SIZE_FILE"
  say "the VM is gone; $0 <size> makes a clean one (remove the old $TS_NAME machine in the Tailscale admin console)"
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  small | medium | large) cmd_up "$sub" "$@" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  ssh) running_pid >/dev/null || die "the VM is not running ($0 start)"; vm_ssh "$@" ;;
  invite) cmd_invite ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  base) cmd_base "$@" ;;
  "" | help | -h | --help) sed -n '3,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command '$sub' (see $0 help)" ;;
esac
