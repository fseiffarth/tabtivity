# Before pushing: full gates, local CI, toolchain bumps

`AGENTS.md` § Gates holds the per-change gates; this file holds the pre-push
routine and the cross-checks behind it. Read it before a push or a Rust
toolchain bump.

Before pushing, run `scripts/gates.sh --all`, then `scripts/ci-local.sh`
(`--fast` for a small change): every Linux step of `ci-cd.yml` plus the
cross-checks below; CI fails if they drift.

`scripts/ci-local.sh` also runs the Windows clippy/check (msvc shims
`~/.local/bin/*-msvc-{rc,lib}-shim`), the `aarch64-apple-darwin` check and the
daemon's `ldd` (no GTK/WebKit/X11/dbus); a missing target or shim is reported,
so read its output before pushing backend changes to paths, process spawning,
`cfg(...)` code or the daemon.

Rust is pinned in `rust-toolchain.toml`, and CI installs the same version
(`RUST_TOOLCHAIN` in `ci-cd.yml`); bump both together, then install it on the
host outside the fence (`~/.rustup` is read-only inside one).
