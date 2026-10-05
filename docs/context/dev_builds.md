# Dev builds, hot reload, and the frozen "Tabtivity (dev)" binary

Why Tabtivity's run/rebuild pipeline works the way it does. `AGENTS.md` § Running
holds the rules an agent must follow; this file holds the mechanics and the
history behind them. Read it when touching `package-dev*.sh`,
`start-tabtivity-*.sh`, `backend-stale.sh`, the `post-commit` hook, or
`services::mobile_control::live_pwa` — or when asked why a build is stale.


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
  **A commit now reaches the phone without a relaunch** (2026-09-17):
  `package-dev.sh` publishes the bundle it just built into `target/mobile-pwa/`
  with a `.stamp`, and `services::mobile_control::live_pwa` serves that in place
  of the embedded copy, so a pull-to-refresh is the whole update path. In
  `--head` mode it publishes *before* cargo starts — the bundle takes two
  seconds, the compile takes two minutes. It is opt-in at compile time
  (`TABTIVITY_MOBILE_LIVE_DIR`, set only by `package-dev.sh` and the hot-reload
  launcher, so a released binary reads nothing off the disk), never serves an
  overlay older than the bundle compiled in, and refuses a bundle missing its
  shell or its stamped entry rather than mixing two. The overlay carries the
  PWA, **not** the sidecar's HTTP API: a mobile feature whose backend half is
  not in the running window will render and then fail its request, which
  `backend:stale` reports rather than hides.
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
  installs and notifies; it never launches or stops anything, and a running
  frozen window keeps its old inode until the user relaunches it. **From an
  agent tab it builds and stops there** (2026-09-04): `services::agent_fence`
  gives an agent a tmpfs `$HOME`, so the install wrote 75 MB into a directory
  that died with the tab and the notification had no session bus to reach —
  every commit reporting success while the desktop icon stayed two days behind.
  The build is real (`target/` is inside the bound project), so
  `start-tabtivity-dev-build.sh` adopts `target/release/tabtivity` at launch instead,
  in the user's own session, trusting the `.frozen` record `package-dev.sh`
  leaves beside a binary that passed `scripts/assert-embedded-frontend.sh` —
  not a re-run of that check, since `dist/` moves on with every gate an agent
  runs and a launch-time re-check refused four days of good builds
  (2026-09-14). The launcher notifies either way: what it adopted, or why not.
  **Since 2026-09-25 a fenced commit does not build at all**: that path never
  moved `package-dev-auto.stamp` in the real home, so the header chip sat at
  "27 behind" and never showed a build for an agent's commit. The script now
  declines under `TABTIVITY_AGENT_FENCE`, and the window (host-side, dev builds
  only) queues it from the chip's poll: `dev_build::queue_if_behind` runs
  `--queue` when HEAD is past the stamp with no build alive or pending, not the
  last failed commit, and not already asked for by this process. The adopt path
  above still covers a snapshot built by hand in `target/release/`.
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
  it and cancels the pass;
  `scripts/package-dev-auto.sh --status` says what it is doing and
  `~/.local/share/tabtivity/package-dev-auto.log` holds the last build's output.
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

