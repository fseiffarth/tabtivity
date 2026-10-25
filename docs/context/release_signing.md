# Release signing — setting the `RELEASE_SIGNING_KEY` secret

The release workflow (`.github/workflows/release.yml`) signs `SHA256SUMS` with an ECDSA P-256 key and the in-app
updater installs nothing whose hash isn't in that signed list (#160,
`services::app_update`). The list covers every asset, the server's
`<slug>-server_*.deb` too (the server guide verifies it by hand; the desktop
updater never picks it, `app_update::is_server_package`). The public half is compiled in from
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
tags. Only `main` is released — `develop` reaches it by PR, and the in-app
updater installs whatever is released. Three ways in:

- **Automatically**, on merging into `main`: when ci-cd passes on a push to
  `main`, `release.yml` (its `workflow_run` trigger) releases that commit as
  `v<package.json version>`, creating the tag itself. A version already
  released is skipped quietly. So every PR merged into `main` is a release.
- **Actions → release → Run workflow** on `main` (or `gh workflow run release
  --ref main`): releases its tip as `v<package.json version>`; any other
  branch is refused. The workflow waits for the tip's ci-cd run,
  and creates the annotated tag itself only once that run is green and the
  checksums are signed — the tag never precedes CI.
- **Push a `v*` tag** (the git bar's Release button, or `git push`): the tag
  must equal `v<package.json version>` at its commit, and that commit must be
  on `main` (its tip or older; the pre-push hook checks this against the last
  fetch, the workflow against GitHub). The workflow waits for
  that commit's ci-cd run; if it did not pass, or anything fails before the
  Release is published, it **deletes the tag again**, so every `v*` tag on
  GitHub has a Release and the name can be pushed again after a fix. The
  Release button already refuses while the tip's CI is running or red
  (`ci_pending` / `ci_failed`, `docs/context/git_push_mcp.md`).

All four bundles (AppImage, deb, exe, dmg) must be there; artifacts expire
after GitHub's retention (90 days by default) — re-run ci-cd on the commit
to release an older one.

## Publish the key's fingerprint outside the repo (open — the maintainer's to do)

The server guide (`docs/guide/server.md`, "From a release") and `scripts/fresh-vm.sh`
trust a public key fetched from the same repository as the release, so a
compromised repository or account could swap both. The threat-model recheck of
2026-10-24 asked for the key's fingerprint to be published somewhere that
repository access does not reach, so a downloader can compare. **Not done**, and
it cannot be done from the repository: nothing here records a fingerprint, on
purpose. To do, in your own terminal:

1. Compute it from the committed key:

   ```bash
   openssl pkey -pubin -in src-tauri/release-signing.pub.pem -outform DER | sha256sum
   ```

2. Publish that value on a channel outside the repo (for example the project
   site, a pinned post on a separate account, or a signed message), and say
   where in `docs/guide/server.md` so the guide can point at it.
3. Also open: `scripts/fresh-vm.sh` verifies a downloaded package against the
   release's `SHA256SUMS` but does not verify `SHA256SUMS` against its
   signature.

## Rotating or losing the key

Every installed build trusts only the public key it was built with. A new key
therefore has to ship in a release signed with the **old** key; a lost old key
means every user updates once by hand. Keep the offline copy.

The hook's escape hatch, `TABTIVITY_SKIP_SIGNING_CHECK=1 git push …`, only lets a
tag through — the release workflow still refuses to publish unsigned (and
deletes the tag again).
