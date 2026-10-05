#!/usr/bin/env bash
# Generate the ECDSA P-256 key pair that signs release checksums (#160).
#
# The public half goes into the repo (src-tauri/release-signing.pub.pem) and is
# compiled into the updater; the private half never enters the repo. Put it in
# the RELEASE_SIGNING_KEY GitHub secret, keep an offline copy (a password
# manager), then delete the file:
#
#   gh secret set RELEASE_SIGNING_KEY --repo fseiffarth/tabtivity < <key file>
#
# Rotating the key means a new public key ships in a release signed with the
# OLD key — builds carrying only the old key cannot verify anything else.
# A lost private key therefore means one manual update for every user.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pub="$repo_root/src-tauri/release-signing.pub.pem"
# The app's names (scripts/lib/brand.sh): $APP_SLUG, $APP_LEGACY_SLUG, app_env.
. "$repo_root/scripts/lib/brand.sh"
key_dir="$(app_env RELEASE_KEY_DIR "$HOME/.config/$APP_SLUG-release-signing")"
key="$key_dir/release-signing.key.pem"
# A key made before the app was renamed sits in the folder named after the
# old name; a second key would be one nobody's installed build can verify.
old_key="$HOME/.config/$APP_LEGACY_SLUG-release-signing/release-signing.key.pem"

for existing in "$key" "$old_key"; do
  if [ -e "$existing" ]; then
    echo "refusing: $existing already exists" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$key_dir"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key"
openssl pkey -in "$key" -pubout -out "$pub"
chmod 644 "$pub"

echo "private key: $key"
echo "public key:  $pub (commit this)"
echo "next: gh secret set RELEASE_SIGNING_KEY --repo $APP_REPO < \"$key\""
