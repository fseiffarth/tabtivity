# Release signing — setting the `RELEASE_SIGNING_KEY` secret

The release job signs `SHA256SUMS` with an ECDSA P-256 key and the in-app
updater installs nothing whose hash isn't in that signed list (#160,
`services::app_update`). The public half is compiled in from
`src-tauri/release-signing.pub.pem`; the private half lives only in the
`RELEASE_SIGNING_KEY` repository secret (plus your offline copy). Without the
secret the release job fails before publishing, and the pre-push hook warns on
every push and refuses a `v*` tag push.

## Step by step

Run these in your own terminal, not in a fenced agent tab — the fence hides
`gh`'s login.

1. **Log in to GitHub CLI** (skip if `gh auth status` already shows you):

   ```bash
   gh auth login
   ```

2. **Find the private key.** `scripts/release-signing-keygen.sh` writes it to
   `~/.config/tabtivity-release-signing/release-signing.key.pem`. Check it belongs
   to the committed public key — no output means it matches:

   ```bash
   openssl pkey -in ~/.config/tabtivity-release-signing/release-signing.key.pem -pubout \
     | diff - src-tauri/release-signing.pub.pem
   ```

   **No key, or it doesn't match?** Until a signed release has shipped, just
   generate a new pair — the script replaces the public key file — and commit
   that file before pushing:

   ```bash
   scripts/release-signing-keygen.sh
   git add src-tauri/release-signing.pub.pem
   git commit -m "Replace the release signing public key"
   ```

   After the first signed release, a new key is a rotation instead (see below).

3. **Set the secret:** <!-- privacy-check: ok — a step heading, no secret -->

   ```bash
   gh secret set RELEASE_SIGNING_KEY --repo fseiffarth/tabtivity \
     < ~/.config/tabtivity-release-signing/release-signing.key.pem
   ```

   Web alternative: repo → Settings → Secrets and variables → Actions → New
   repository secret, name `RELEASE_SIGNING_KEY`, value the whole PEM file
   including the `-----BEGIN/END PRIVATE KEY-----` lines.

4. **Check it is there:**

   ```bash
   gh secret list --repo fseiffarth/tabtivity   # lists RELEASE_SIGNING_KEY
   ```

   The next `git push` stays quiet: the hook sees the secret and writes
   `.git/tabtivity-release-signing-secret-ok`, so it never asks GitHub again.

5. **Keep an offline copy, then delete the file.** Store the PEM in a password
   manager — GitHub secrets can't be read back. Then:

   ```bash
   shred -u ~/.config/tabtivity-release-signing/release-signing.key.pem
   ```

6. **Push as usual.** The first `v*` tag after this runs the "Sign release
   checksums" step, which verifies its own signature against the committed
   public key — a wrong secret fails there, not in users' updaters.

## Rotating or losing the key

Every installed build trusts only the public key it was built with. A new key
therefore has to ship in a release signed with the **old** key; a lost old key
means every user updates once by hand. Keep the offline copy.

The hook's escape hatch, `TABTIVITY_SKIP_SIGNING_CHECK=1 git push …`, only lets a
tag through — the release job still refuses to publish unsigned.
