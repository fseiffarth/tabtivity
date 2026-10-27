# Dev builds, hot reload, and the frozen "Tabtivity (dev)" binary

Why Tabtivity's run/rebuild pipeline works the way it does. `AGENTS.md` § Running
holds the rules an agent must follow; this file holds the mechanics and the
history behind them. Read it when touching `package-dev*.sh`,
`start-tabtivity-*.sh`, `scripts/lib/dev-launcher.sh`, `backend-stale.sh`, the
`post-commit` hook — or when asked why a build is stale.


**Agents must never start Tabtivity** (user, 2026-07-29) — not via
`./start-tabtivity-tauri-hotreload.sh`, not via `npm run tauri:dev`, not
backgrounded, not "just to check one thing". **Never stop an instance you did
not start**, either: a running window holds the user's open tabs and live
terminals. The app's lifecycle is the user's alone.

To verify something live, ask the user to launch Tabtivity (or use a window they
already have open) and report back, or hand them the exact steps to click
through. Otherwise report the automated gates only, and say plainly that the
change was not run live.

- `src/` changes hot-reload into a running window — don't ask for a restart.
- `src-tauri/` changes do not: `tauri dev` runs with `--no-watch`, because its
  Rust watcher rebuilds *and relaunches the window* on any backend write,
  taking the user's open tabs with it. Backend edits accumulate harmlessly
  until the user restarts deliberately. `tauri:dev:watch` is the opt-in
  escape hatch.
- The cost is a backend fix that compiles and is silently not in the window.
  **Run `npm run backend:stale` after backend edits and report the result**;
  never restart the app to apply them. It knows every shape Tabtivity runs in
  (hot-reload, frozen `package:dev`, packaged, AppImage), and it asks the
  running Mobile sidecar over loopback which PWA bundle it is actually serving
  — mtimes are a proxy, that answer is not.
- The phone's PWA is embedded into the binary too (`build.rs` bakes
  `mobile-dist/` in), so it goes stale on its own schedule and nothing in the
  window says so. `beforeDevCommand` re-bundles it on every dev start, and a
  `post-commit` hook reports the seam when it drifts anyway; `npm run
  mobile:bundle` rebuilds it without the type-check, `mobile:build` with.
  **The phone app always comes from the binary** (2026-10-13). From
  2026-09-17 a dev build served a newer bundle `package-dev.sh` published into
  `target/mobile-pwa/` (`live_pwa`), so a commit reached the phone with a
  pull-to-refresh and no relaunch. `target/` is inside the project, which
  every agent fence binds read-write, so any agent could plant a bundle there
  that ran as the paired phone and installed a lasting service worker (threat
  recheck 2026-10-08, gap 20). The overlay, its stamp, its build-time
  constants and the env export are gone; a leftover `target/mobile-pwa/` is
  never read. A new phone bundle reaches the phone with the window's (and
  the sidecar's) next relaunch, like every other part of the binary.
- Double-starts are blocked by `scripts/guard-single-instance.sh` (wired into
  the launcher and the `pretauri:dev` hook). It also refuses when port 1420 is
  held by an orphaned vite — a second `tauri dev` would otherwise attach to the
  *first* session's dev server and silently render its stale module graph.
- Dogfooding: `./start-tabtivity-dev-sandbox.sh` runs the same dev server with
  `TABTIVITY_STATE_DIR`/`TABTIVITY_HOME` redirected under
  `~/.local/share/tabtivity-dev/`, so a disposable dev window coexists with a
  packaged daily-driver Tabtivity (`npm run package`) without sharing any state —
  sessions live in the packaged build, out of HMR's reach. Still one dev
  session at a time (port 1420), and still launched by the user only.
- A truly fresh install (no keychain, `~/.claude`, CLIs or host packages):
  `scripts/fresh-vm.sh` — one QEMU desktop VM (copy-on-write over a baked
  Ubuntu GNOME image, built on the first call); `fresh-vm.sh [version|file]`
  swaps the installed release in place (the guest starts it at login),
  `--fresh`/`reset` go back to a clean desktop; host-only (`/dev/kvm`). A host
  run writes the "(VM)" desktop entry (app grid and desktop icon), which runs
  an installed copy of the script under the VM folder, never the checkout's.
  With a VM already there a call only UPDATES Tabtivity in it (no question, no
  new VM, no base rebuild, state kept): a stopped VM boots with the package
  installed over it; a running one gets the package copied in through the QEMU
  guest agent socket `qga.sock` (`qga_exec --put`, 1 MiB per guest-exec,
  SHA-256 checked), installed as root by the same `install.sh` the boot disc
  carries, and the app quit and started again as `tester`. A silent agent is
  reported ("Nothing was changed"), never waited on; `status` asks the running
  guest what it has. `fresh-vm.sh current` installs the newest package built in
  the checkout (`target/release/bundle/{deb,appimage}`, from
  `APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:bundle`; the frozen dev build is a
  bare binary, so it is no source); the script never builds. The install stamp
  is file name plus the head of the SHA-256, so a rebuild at the same version
  is installed again (`apt-get --reinstall`) and the identical file is not.
  The guest login is `tester` / `tester`. Bake and desktop use the same
  standard VGA so the GPU and NIC PCI slots stay stable; boot output is
  saved in `<VM folder>/serial.log` (cloud images direct it to the serial
  console, leaving the QEMU window looking stuck during package installation).
  The bake explicitly registers GDM and verifies the display-manager unit and
  graphical boot target before accepting the base. Each package disc repeats
  that registration before checking the package stamp, repairing older bases
  without deleting the VM. Unfinished desktop packages are repaired first;
  package installs keep the prewritten GDM config without prompting and
  temporarily block service starts (restoring the guest's prior policy), so
  GDM cannot wait on the install hook that must finish before it starts.
  `fresh-vm.sh repair` performs the same repair in the running guest through
  the guest agent, then starts GDM; run it from a host terminal to avoid typing
  in the guest console. It returns package errors and GDM status to the host.
  A timeout before command submission reports that no repair started: close
  QEMU, then run the launcher with `latest` and keep the VM to repair from the
  package disc instead (no working guest agent required). Desktop setup also
  enables the agent service and starts it when its virtio channel is present.
- `npm run package:dev` freezes the *current working tree* as a release binary
  behind the "Tabtivity (dev)" desktop entry (`start-tabtivity-dev-build.sh`, binary
  at `~/.local/share/tabtivity/tabtivity-dev`). No hot reload: the user works and
  spots bugs in it, then checks fixes in the hot-reload window. Both use the
  real state, so **only one runs at a time** — each launcher refuses with a
  desktop notification while the other is up. Re-run it to move the frozen
  window to a newer snapshot.
- **Every commit re-freezes it by itself** (user, 2026-09-03): the `post-commit`
  hook queues `scripts/package-dev-auto.sh`, which builds detached (the commit
  never waits), nice'd/`SCHED_IDLE` so it does not fight the window it serves,
  and coalescing — each pass first waits until no commit has landed for 30 s
  (`TABTIVITY_DEV_BUILD_SETTLE`), and a commit landing mid-build **cancels** it
  (user, 2026-09-22) and the loop starts over on the new commit, so a commit
  series or a rebase costs one build and ends on the *last* commit. Only the
  compile is cancellable: `package-dev.sh` touches
  `package-dev-auto.installing` once cargo finishes, and past it the pass runs
  to the end — a killed `install` would leave a truncated binary installed.
  The build runs in its own process group so the cancel reaches every rustc;
  a cancelled pass is not a failure (no `.failed` record), and the freeze
  tree's stale `index.lock` is cleared after it.
  **It freezes the commit, not the tree** (user, 2026-09-14): `package-dev.sh
  --head` checks `HEAD` out into the detached worktree `target/freeze-tree`
  (node_modules symlinked, cargo target dir shared) and builds there, so the
  frozen binary is exactly one commit — never "+local" with someone else's
  dirty edits swept in, and never failed by an `npm run build` that rewrites
  `dist/` mid-compile. `npm run package:dev` by hand still freezes the live
  tree, as the explicit way to try an uncommitted change. It
  installs and stays quiet — no desktop notification per commit (user,
  2026-10-07: they piled up on the lock screen); the header chip shows the
  outcome. It never launches or stops anything, and a running
  frozen window keeps its old inode until the user relaunches it. **From an
  agent tab it builds and stops there** (2026-09-04): `services::agent_fence`
  gives an agent a tmpfs `$HOME`, so the install wrote 75 MB into a directory
  that died with the tab and the notification had no session bus to reach —
  every commit reporting success while the desktop icon stayed two days behind.
  The build is real (`target/` is inside the bound project), and
  `start-tabtivity-dev-build.sh` adopts `target/release/tabtivity` at launch
  instead, in the user's own session — but **only a build the host made**
  (2026-10-13, gap 20). The `.frozen` record beside the artifact used to be
  the evidence (a launch-time re-run of `scripts/assert-embedded-frontend.sh`
  refused four days of good builds, 2026-09-14, since `dist/` moves on with
  every gate an agent runs), and the re-check stayed as a fallback; both sit
  in, or check against, the fence-writable tree, so an agent could plant a
  binary and a matching record and the next click ran it unfenced. Now
  `package-dev.sh`, when it runs outside a fence (`dev_on_host`: no fence
  variable, app dir not a tmpfs), appends `<sha256> <commit> <version>
  <built>` to `~/.local/share/tabtivity/dev-builds/verified` (last 20 kept,
  mode 600). No fence binds the state dir (it is masked, and inside a fence
  `$HOME` is the agent's own home), so no agent can write it. The launcher
  copies the artifact next to the installed binary, hashes the copy, adopts it
  only when that hash is listed (and the list is a private regular file the
  user owns), takes the label and the installed `.frozen` from the list, and
  otherwise notifies why and opens the snapshot it has. There is no fallback.
  A build made inside a fence (an agent running `npm run package:dev`) is
  never adopted; the window's own queued build of the same commit is.
  **The launcher runs from a copy** (2026-10-13, gap 20 follow-up): the desktop
  entry used to run the checkout's `start-tabtivity-dev-build.sh`, which
  sources `scripts/lib/brand.sh` and runs `scripts/retain-dev-build.sh` from
  the checkout too, so an agent's uncommitted edit to any of them ran
  unfenced at the next click, whatever the hash said. The same host-side
  `package-dev.sh` now installs the launcher, every helper it sources or runs
  and the two files `brand.sh` reads names from (`dev_launcher_files`) into
  `~/.local/share/tabtivity/dev-launcher/` — in `--head` mode read out of the
  commit itself (`dev_git ls-tree` + `cat-file blob` on `HEAD_SHA`: regular
  file entries only, no replace refs, no lazy fetch, no hooks or fsmonitor),
  never from `target/freeze-tree`, which a fence binding the project can edit
  during the build; in `--tree` mode from the working tree, which that mode
  freezes uncommitted anyway — swapped in whole, with `source-root`
  naming the checkout, and points the desktop entry's `Exec=` there (also when
  the install itself is held back under a running window). From the copy the
  checkout is data only: the binary it built and HEAD for the "behind"
  notice. The chip's **Relaunch now** runs the copy too (the checkout's only
  while none exists yet). A *committed* launcher edit still reaches the user,
  through the next queued build (the residual below).
  **Since 2026-09-25 a fenced commit does not build at all**: that path never
  moved `package-dev-auto.stamp` in the real home, so the header chip sat at
  "27 behind" and never showed a build for an agent's commit. The script now
  declines under `TABTIVITY_AGENT_FENCE`, and the window (host-side, dev builds
  only) queues it from the chip's poll: `dev_build::queue_if_behind` runs
  `--queue` when HEAD is past the stamp with no build alive or pending, not the
  last failed commit, and not already asked for by this process. The adopt path
  above covers a freeze held back under a running window.
  **Residual, accepted (C3, 2026-10-12):** this queue runs the checkout's
  `scripts/package-dev-auto.sh` unfenced whenever HEAD moves, and the build it
  starts runs the checkout's `package-dev.sh`, `npm run build`, `build.rs` and
  whatever else the commit holds, on the host; the result is recorded as
  verified and adopted. So an agent's commit runs on the host at the next dev
  build. That is what building agent-written code means; a click-to-build gate
  was considered and declined. The cargo target dir and the freeze tree stay
  fence-writable while the build runs, so the list proves "a host
  `package-dev.sh` hashed this binary", not "it was built from the commit"; the
  launcher copy is read from the commit's objects. The git calls
  `package-dev.sh` makes on the freeze tree (`worktree`, `checkout`, `clean`)
  go through `dev_git`, so the repo's hooks and fsmonitor do not run there; a
  filter driver in `.git/config` still would (inside C3: an uncommitted edit
  to `package-dev.sh` itself runs too). Dev builds only: a released binary has no
  source root, no chip and no queue.
  **A failed pass does not end the queue** (2026-09-15): a commit that landed
  mid-build is a different tree — usually the one that fixes it, since a
  change split over two commits compiles only as a pair — so the loop goes on
  to it instead of leaving it "queued" for good. A failure is written to
  `~/.local/share/tabtivity/package-dev-auto.failed` (commit, status, when),
  which `--status`, `npm run backend:stale` and the launcher all read: the
  launcher compares the installed snapshot's recorded commit (`.frozen`, now
  kept beside the installed binary) with `HEAD` and notifies how many commits
  behind it is opening, and why — the hook's own failure notice never
  arrives from an agent tab.
  **Each install is also kept** (2026-09-23) under
  `~/.local/share/tabtivity/dev-builds/tabtivity-<commit>` — a hardlink made by
  `scripts/retain-dev-build.sh` from both install paths (`package-dev.sh` and
  the launcher's adopt), newest six by default (`TABTIVITY_DEV_BUILDS_KEEP`).
  `install` replaces the path on every freeze, so a window that crashes has
  been running a `(deleted)` binary for hours, and its `module+offset` frames
  named nothing: five main-process heap-corruption crashes (2026-09-17..23)
  went undiagnosed that way, and rebuilding the commit did not help — the same
  commit, toolchain and flags produced a different code layout, so the names
  it yielded were plausible and wrong. The crash header now carries
  `commit=<short sha>` (`TABTIVITY_BUILD_COMMIT` from `build.rs`), and
  `scripts/crash-symbolize.sh` resolves against the retained copy when the
  recorded path is stale.
  It declines in CI and from a linked worktree (freezing an agent's tree over
  the user's binary is exactly the surprise to avoid). Off with `git config
  tabtivity.autoDevBuild false`, or `TABTIVITY_NO_AUTO_DEV_BUILD=1` for one commit.
  **Pause** (user, 2026-09-30) is the temporary switch for when the cores are
  wanted elsewhere: `package-dev-auto.sh --pause` (the chip's "Pause
  auto-builds", `dev_build_set_paused`) leaves `package-dev-auto.paused`, which
  declines every queue — the hook's and `queue_if_behind`'s — and makes a
  running pass cancel itself like a superseded one (not recorded as a failure,
  and an install already under way still finishes). `--resume` removes it and
  queues HEAD if the snapshot fell behind meanwhile. **Build now** (user,
  2026-10-02; `--build-now`, the chip's button while paused, `dev_build_now`)
  builds HEAD once without resuming: nothing when the stamp already is HEAD,
  otherwise it skips the settle wait and leaves `package-dev-auto.once`, which
  only the running loop reads (never `queue()`, so a stale one cannot let
  commits build while paused) and drops after one pass; pausing again removes
  it and cancels the pass. `--build-now` and `--resume` return only once the
  detached run holds the lock (at most 5 s; `await_run`), since the chip
  re-reads at once and an earlier read still said idle — "Build now" looked
  like it needed a second click (2026-10-20); the hook's `--queue` never waits.
  **Stop** (user, 2026-10-27; `--stop`, the chip's "Stop build" while a pass
  runs or settles, `dev_build_stop`) cancels only that pass: auto-builds stay
  on. It writes HEAD into `package-dev-auto.stopped`, which a running pass
  cancels itself for (not a failure; an install under way still finishes) and
  which keeps `queue_if_behind` from starting that same HEAD again on its next
  poll; every `queue()` (the next commit), `--resume` and `--build-now` drop
  it, and "Build now" is offered after a stop as while paused. `--stop` waits
  for the run to let go of the lock (at most 15 s), and the settle wait now
  sleeps a second at a time so a stop ends it at once;
  `scripts/package-dev-auto.sh --status` says what it is doing and
  `~/.local/share/tabtivity/package-dev-auto.log` holds the last build's output.
  After each run the loop calls `scripts/target-prune.sh` (2026-10-21; `target/`
  had reached 1.1 TB from per-feature incremental dirs, stale dependency
  artifacts and the cross-check trees): over `TARGET_PRUNE_CAP_GB` (250) it
  deletes incremental dirs oldest first, then `examples`, then `deps` files
  unread for 7 days, then the Windows/macOS trees, stopping once under the cap.
  It never touches `release/` or `freeze-tree/` and does nothing while any
  cargo/rustc runs. `--dry-run` lists what it would remove.
  The header's dev-build chip (`header/DevBuildIndicator.tsx`,
  `services::dev_build`, 2026-09-18) reads the same files: step, elapsed, an
  estimate from the last good pass, failure, commits behind, and "relaunch to
  pick it up". It exists only in binaries built with `TABTIVITY_DEV_SOURCE_ROOT`
  (`package-dev.sh` and the hot-reload launcher export it), and a log line
  format change in either script silently degrades its step readout.
  In the frozen window, once a newer snapshot is installed over it or built
  and recorded in `target/release/` (the fenced case the launcher adopts), its
  menu offers **Relaunch now** (2026-09-21): `dev_build_relaunch` spawns a
  detached helper that waits for this pid to exit (gives up after 2 min) and
  runs `start-tabtivity-dev-build.sh`, then closes the main window through the
  ordinary quit. User-clicked only — agents still never start or stop Tabtivity.

