#!/usr/bin/env bash
# Build the server's .deb: the gateway, the per-user daemon, the admin helper
# and the two web bundles the gateway serves, in the paths the admin helper's
# `install` expects (`/usr/lib/<slug>/`, `/usr/share/<slug>/`). It ships with
# the desktop bundles in the same GitHub release (ci-cd.yml's package-server
# job, release.yml); docs/guide/server.md installs it.
#
#   scripts/package-server-deb.sh              # build everything, then pack
#   scripts/package-server-deb.sh --no-build   # pack what is already built
#   scripts/package-server-deb.sh --out DIR    # where the .deb goes (default
#                                              # target/release/bundle/server)
#
# The package only places files. Accounts, units, polkit rule and sudoers come
# from `<slug>-admin-helper install`, which the admin runs once with the
# server's origins (guide step 4). An upgrade restarts the server's services
# that are running; agents keep running in the tmux units, which are left
# alone. Removing the package stops the services, so nothing runs a binary
# that is gone.
#
# Linux only, the build host's architecture. The minimum glibc in Depends is
# read off the binaries, so it follows the runner (ubuntu-24.04: 2.39).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_SLUG, $APP_DISPLAY.
. "$ROOT/scripts/lib/brand.sh"

build=1
out="$ROOT/target/release/bundle/server"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0 ;;
    --out) out="$2"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"
version="$(node -p "require('./package.json').version")"
arch="$(dpkg --print-architecture)"
pkg="$APP_SLUG-server"
bins=("$APP_SLUG-serverd" "$APP_SLUG-gateway" "$APP_SLUG-admin-helper")
# CARGO_TARGET_DIR may point elsewhere (CI's rust-cache, a scratch dir).
target="${CARGO_TARGET_DIR:-$ROOT/target}"

if [ "$build" = 1 ]; then
  # The bundles only: the type-check is the build gate's, not packaging's.
  npm run mobile:bundle
  npm run web:bundle
  cargo build --release -p app-serverd -p app-gateway
fi

for b in "${bins[@]}"; do
  [ -x "$target/release/$b" ] || { echo "missing $target/release/$b (build it, or drop --no-build)" >&2; exit 1; }
done
for d in web-dist mobile-dist; do
  [ -f "$d/index.html" ] || { echo "missing $d/index.html (npm run web:bundle / mobile:bundle)" >&2; exit 1; }
done

# A server has no desktop session: no binary may pull in a window toolkit.
for b in "${bins[@]}"; do
  if ldd "$target/release/$b" | grep -Ei 'gtk|gdk|webkit|javascriptcore|libx11|xcb|dbus|soup|ayatana'; then
    echo "$b links a desktop library" >&2
    exit 1
  fi
done

glibc="$(for b in "${bins[@]}"; do objdump -T "$target/release/$b"; done \
  | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
[ -n "$glibc" ] || { echo "could not read the binaries' glibc version" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
root="$stage/root"
install -d -m 0755 "$root" "$root/DEBIAN" "$root/usr/lib/$APP_SLUG" "$root/usr/share/$APP_SLUG" "$root/usr/share/doc/$pkg"
for b in "${bins[@]}"; do
  install -m 0755 "$target/release/$b" "$root/usr/lib/$APP_SLUG/$b"
done
cp -r web-dist mobile-dist "$root/usr/share/$APP_SLUG/"
# Dev-server leftovers never ship.
find "$root/usr/share/$APP_SLUG" -name '*.map' -delete
cat LICENSE-MIT LICENSE-APACHE > "$root/usr/share/doc/$pkg/copyright"
find "$root/usr" -type d -exec chmod 0755 {} +
find "$root/usr/share" -type f -exec chmod 0644 {} +

installed_kb="$(du -sk "$root/usr" | cut -f1)"
cat > "$root/DEBIAN/control" <<EOF
Package: $pkg
Version: $version
Architecture: $arch
Maintainer: $APP_DISPLAY <noreply@github.com>
Installed-Size: $installed_kb
Depends: libc6 (>= $glibc), libgcc-s1, systemd, tmux (>= 3.2), bubblewrap, git, curl
Recommends: podman, uidmap, jq
Section: net
Priority: optional
Homepage: https://github.com/fseiffarth/$APP_SLUG
Description: $APP_DISPLAY server (preview)
 The multi-user server version of $APP_DISPLAY: a gateway that browsers and
 phones sign in to, a sandboxed daemon per user, and the admin tool that sets
 the server up. After installing, run
 /usr/lib/$APP_SLUG/$APP_SLUG-admin-helper install (see the server guide).
EOF

# The server's units, socket-activated ones by their socket too, so a stop
# is not undone by the next connection. tmux@ is never touched: it holds the
# users' agents.
services="$APP_SLUG-gateway.service $APP_SLUG-auth-keeper.service $APP_SLUG-keybroker.service $APP_SLUG-hub.service $APP_SLUG-calendar.service '$APP_SLUG-serverd@*.service'"
sockets="$APP_SLUG-auth-keeper.socket $APP_SLUG-keybroker.socket $APP_SLUG-hub.socket $APP_SLUG-calendar.socket '$APP_SLUG-serverd@*.socket'"

cat > "$root/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
[ "\$1" = configure ] || exit 0
if [ -n "\$2" ]; then
  # An upgrade: every running service picks up the new binaries. Restarting
  # only the gateway would leave sessions and the key, sharing and calendar
  # services on the old version.
  if [ -d /run/systemd/system ]; then
    systemctl try-restart $services || true
  fi
elif [ ! -e /etc/systemd/system/$APP_SLUG-gateway.service ]; then
  echo "$APP_DISPLAY server installed. Set it up with:"
  echo "  sudo /usr/lib/$APP_SLUG/$APP_SLUG-admin-helper install --origin https://HOST --content-origin https://HOST:8443"
fi
EOF

cat > "$root/DEBIAN/prerm" <<EOF
#!/bin/sh
set -e
if [ "\$1" = remove ] && [ -d /run/systemd/system ]; then
  systemctl stop $sockets $services || true
fi
EOF
chmod 0755 "$root/DEBIAN/postinst" "$root/DEBIAN/prerm"

mkdir -p "$out"
deb="$out/${pkg}_${version}_${arch}.deb"
# xz, not dpkg's zstd default: Debian's dpkg before 1.21.18 cannot read zstd.
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb" >/dev/null
echo "$deb"
