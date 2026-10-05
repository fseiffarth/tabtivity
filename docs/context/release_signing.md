# Release signing — setting the `RELEASE_SIGNING_KEY` secret

The release workflow (`.github/workflows/release.yml`) signs `SHA256SUMS` with an ECDSA P-256 key and the in-app
updater installs nothing whose hash isn't in that signed list (#160,
`services::app_update`). The public half is compiled in from
`src-tauri/release-signing.pub.pem`; the private half lives only in the
`RELEASE_SIGNING_KEY` repository secret (plus your offline copy). Without the
secret the release workflow fails before publishing, and the pre-push hook warns on
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

6. **Push as usual.** The first release after this runs the "Sign release
   checksums" step, which verifies its own signature against the committed
   public key — a wrong secret fails there, not in users' updaters.

## How a release is cut

A release only ever ships a commit `ci-cd.yml` passed on a branch push, and
`release.yml` never rebuilds: it signs and publishes the bundles that green
run built (its `package*` artifacts). `ci-cd.yml` itself no longer runs on
tags. Two ways in:

- **Actions → release → Run workflow** on a branch: releases its tip as
  `v<package.json version>`. The workflow waits for the tip's ci-cd run,
  and creates the annotated tag itself only once that run is green and the
  checksums are signed — the tag never precedes CI.
- **Push a `v*` tag** (the git bar's Release button, or `git push`): the tag
  must equal `v<package.json version>` at its commit. The workflow waits for
  that commit's ci-cd run; if it did not pass, or anything fails before the
  Release is published, it **deletes the tag again**, so every `v*` tag on
  GitHub has a Release and the name can be pushed again after a fix. The
  Release button already refuses while the tip's CI is running or red
  (`ci_pending` / `ci_failed`, `docs/context/git_push_mcp.md`).

All four bundles (AppImage, deb, exe, dmg) must be there; artifacts expire
after GitHub's retention (90 days by default) — re-run ci-cd on the commit
to release an older one.

## Rotating or losing the key

Every installed build trusts only the public key it was built with. A new key
therefore has to ship in a release signed with the **old** key; a lost old key
means every user updates once by hand. Keep the offline copy.

The hook's escape hatch, `TABTIVITY_SKIP_SIGNING_CHECK=1 git push …`, only lets a
tag through — the release workflow still refuses to publish unsigned (and
deletes the tag again).
