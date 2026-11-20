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

## CI skips a test job that cannot fail differently

`ci-cd.yml`'s `ci-plan` job (`scripts/ci-skip.sh`, whose header holds the
rules) lets a branch push skip an OS's test job when that OS already passed on
the same content, or when the push's `CI-Only:` trailers leave it out and it
was green on the push's `before` commit. Why: a macOS-only fix used to re-run
the hour-long Linux and Windows suites, and a docs-only push all three.
Limits by design: a trailer is the author's word (a cfg-gated edit in a shared
file still compiles everywhere), so main, which release.yml releases from,
always runs every OS; a `workflow_dispatch` run is a full run too. The package
jobs still build on every push and accept a test job ci-plan skipped.

## A cargo step that rebuilds everything, or never ends

Two things once made every cargo step of a CI job recompile the backend
(2026-11-15; macOS spent 37 minutes per step). Keep both out of `build.rs`:

- A `rerun-if-changed` path that does not exist: cargo reruns the script and
  recompiles the crate on every build. A fresh clone has no `.git/packed-refs`,
  so only CI saw it. Watch a path only when it exists.
- Bytes spelled as an integer-literal array: the phone bundle that way cost
  each compile of the crate a minute and 4 GB (swap, on the 7 GB macOS
  runner). Copy the file into `OUT_DIR` and `include_bytes!` it.

A third cost is memory, not a rebuild: the crate's two compiles for `cargo
test` (library, test harness) peak at about 7 GB and 10 GB and cargo runs them
side by side, on a macOS runner with 7 GB — 38 minutes of mostly swap for five
minutes of compiler work (measured 2026-11-16; `-j1` and `debug = false` leave
both peaks where they are). `test-macos` sets `CI_CARGO_SPLIT_BUILD=1`, which
makes `ci-failed-first.sh` build the harness first and alone. That only stops
the overlap; no single compile fits until the crate is split.

The backend test steps carry their own `timeout-minutes`, inside the job's. A
job timeout cancels the run and names nothing; a step timeout fails it, and
`ci-failed-first.sh hung` then says whether the run ran out of time (still
compiling, or tests still printing at the cut) or stalled (silent for two
minutes or more), names the tests that were still running (an error
annotation each) and lists them to run first next time. A silent test binary
is a stall, not one slow test: libtest prints `has been running for over 60
seconds` itself. The backend run's watchdog stamps when the log last grew and,
after `CI_TEST_STALL_SECONDS` (300) of silence, dumps the tests libtest had
started and not reported, the processes and the test process's threads
(`sample` on macOS) into the step's log. Size a step timeout that compiles for
a build with no cache: a failed job saves no Rust cache, so one set too tight
never gets a warm build. `test-macos` compiles in its own `Build backend
tests` step (`ci-failed-first.sh build`, 80 minutes), so its test steps get
20; a cache miss there (2026-11-20, run 673: 23 minutes for the harness alone,
then cut off still compiling) used to eat the test step's hour.

## What a CI run keeps from the one before

- **Frontend tests, branch pushes other than main:** only the tests the change
  can reach. `ci-failed-first.sh frontend` records the commit the suite last
  passed at on that OS (`.ci-failed/frontend-passed.txt`, kept with the failed
  list) and `ci-vitest-select.mjs` hands `vitest related` what differs since,
  plus the tests that read files off the disk, which no import graph shows.
  The base is that commit, not the push's `before`: a run a newer push
  cancelled tested nothing. Main, a PR and a run started by hand take the
  whole suite, and so does any run the selector cannot answer for (its
  `WHOLE_SUITE` list, a deleted source file, a real `package.json` change).
  A test that reads the disk through a helper the selector's `DISK` pattern
  misses is caught only on main.
- **Rust dependencies:** the Rust cache, saved by a red test job too
  (`cache-on-failure`). The workspace's own crates are compiled on every run.
- **No npm cache:** its key hashes `package-lock.json`, which the version bump
  changes on every push. The store holds 10 GB for the whole repository; past
  that GitHub evicts the least recently used, which is how the package jobs
  lost their caches during a red streak (2026-11-15).
