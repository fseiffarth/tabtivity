# Safe for everyone plan — Tabtivity for people who aren't security experts

Plan for TODO Group O #2321–#2333 (`todo/group-o-security.md`, section
"Safe for everyone"). Written 2026-09-24 from `docs/threat_model.md` as re-checked
against HEAD `d73da93e`. Verify each fact against code before acting on it.

## Who this is for

Today Tabtivity is safe for its author. It is not yet safe to hand to:

- **a typical software engineer**, who uses agents in auto-approve mode, clones
  random repos and never reads a trust prompt twice, or
- **a teacher** (or anyone else who isn't technical), who is often on
  Windows or macOS, never updates system packages, and clicks "Yes" on every
  dialog.

## The one sentence that explains every item below

**The threat model marks about 15 rows "⚠️ yours". Each is a decision it
leaves to an expert.** A non-expert can't make those calls. Each "yours" row
must become a safe default, something Tabtivity handles itself, or a warning the
user can't miss. Behind that sits a second problem: almost every defence is
"fixed, not live-verified". Telling non-experts it is safe needs proof, not a
code read.

Three rules follow:

1. **Nothing received or opened runs code (tiers 0–2), and one bug must not
   mean full compromise.** Today one script in a webview reaches all 630
   commands.
2. **The default setup has no expert switches on.** Risky features are opt-in,
   and each explains its risk where you turn it on.
3. **Every "✅" is backed by a live check on the platforms we claim.** A green
   code read is not enough.

## Where we are (facts this plan relies on)

- **IPC:** 630 `#[tauri::command]`s, no per-command permissions (`build.rs` has
  no `app_manifest`); every `main`/`detached-*`/`present-*` webview reaches all
  of them. Only the escape-first renderers, the CSP and the frozen prototype
  stand in the way.
- **Fence:** on by default (`Settings::agent_fence()`), bubblewrap on Linux,
  `sandbox-exec` on macOS. **Windows has no fence** (`platform_fenceable()`);
  agents run unfenced there. The first agent spawn is refused until the user
  accepts that once (`agent_fence_platform_accepted`, #2327 b); a WSL2-hosted
  fence is the candidate for a real one (#2327 c).
- **Fence network:** the fence shares the host network namespace. `DISPLAY` is
  not scrubbed and the abstract X11 socket is reachable. On a desktop that
  grants `SI:localuser:$USER` (GNOME's default), a same-uid client may connect
  without a cookie and inject keystrokes into host windows (XTEST). Not audited.
- **Updates:** signed and checked since #160, but the check runs only when you
  open the Updates panel (`UpdatesPanel.tsx` `runCheck` on mount). The signing
  key is a GitHub secret, so a compromised CI run can still sign.
- **Engine:** WebKitGTK and GStreamer come from the system. Their security
  depends on the user updating them; Tabtivity never checks.
- **Prompts:** `exec_trust` asks once per project program (latexmkrc, prettier,
  git hooks). The question is correct, but a non-expert says yes.
- **No `SECURITY.md`** and no stated disclosure path.
- **Open hardening:** #869 (zip caps, pdf.js eval, CSP `base-uri`/`form-action`,
  CalDAV credential leak, API keys to non-agent tabs), #146 (Python probes),
  #868 residual (OpenVPN `plugin` as root), #864 residual (tmux < 3.2).

## Phase 1 — close what's known (small, no product decisions)

- **#2321 X11 reach from the fence.** Audit first. Then either scrub
  `DISPLAY`/`XAUTHORITY` and block the abstract socket (`--unshare-net` plus a
  loopback proxy for the agent's API hosts, reusing the VM proxy's allowlist
  logic), or document why it doesn't work. Splits the "shared network
  namespace" line out of #869.
- **Finish #869** as already written there (not repeated here).
- **#2322 tmux < 3.2:** refuse to start token-carrying tabs on an old tmux, or
  fall back to a tmux-less spawn, instead of leaking to other users.
- **#146:** gate the Python probes and the auto-selected in-tree `.venv` like
  every other project program.

## Phase 2 — contain the next renderer bug (structural)

- **#2323 Per-window command permissions.** Declare app commands in `build.rs`
  (`tauri_build::Attributes::app_manifest`) and grant them by capability:
  - `main`: everything it uses today, in named permission sets (`terminal`,
    `git-write`, `mail-send`, `fs-write`, `update-install`, …) so later
    splits are cheap.
  - `detached-*`: only the sets its tab kind needs.
  - `present-*`: read-only viewer commands.
  - `browser-*`: nothing (unchanged).
  A capability test pins each window's grant list, like
  `tests/capability_scope.rs` pins the CSP. The payoff: a renderer bug in a
  presenter or detached viewer can no longer spawn a terminal.
- Later (not in this plan): split `main`'s own sets by feature, so that the mail
  view's webview can't reach `pty_spawn`. That needs mail in its own webview —
  a bigger change.

## Phase 3 — safe by default (the product change)

- **#2324 Safety profiles.** A `settings.safety_profile`: `standard` |
  `developer` | `expert`.
  - **Standard** (new installs): fence required (Windows: see #2327); root
    console can't read projects; schedule MCP off; auto-sync off; VPN import
    off; phone pairing hidden; the TeX hover preview stays (it's hardened);
    trust prompts per #2325.
  - **Developer:** today's defaults.
  - **Expert:** everything, no extra warnings.
  A profile only sets **defaults and visibility**. It never rewrites a choice
  the user made explicitly. Existing installs become `developer` so nothing
  changes under them (persisted JSON round-trips; a missing key means
  `developer` for an existing state dir, `standard` for a fresh one).
- **#2324 Safety panel** (same item): one screen listing each "⚠️ yours" row
  as on/off with a one-line risk, linking to the setting.
- **#2325 Trust prompts a non-expert can answer.** Default button is "Don't
  run". The prompt says *what* would run, in words ("this project's LaTeX
  config runs a program on your computer"). In Standard, the "Run" choice runs
  it in the project container when one is available. Remembered answers are
  listed in the Safety panel and can be revoked.
- **#2326 Unfenced-and-bypass badge.** When an unfenced tab's CLI reports a
  bypass/auto-approve mode (the hook already records the mode), show a red
  badge on the tab. **Display only:** AGENTS.md forbids Tabtivity choosing or
  changing the mode, and this plan keeps that.
- **#2327 Windows containment.** Pick one (**your call**):
  (a) in Standard, agents run in the project container (Docker Desktop/WSL2)
  and a missing container runtime blocks agent tabs with a one-click install;
  (b) Windows stays unfenced and Standard asks the user to accept "agents on
  this computer run with your full rights" once.
  (a) is the honest one; (b) ships sooner.
- **#2328 Planted `commondir` warning.** Tabtivity's own git ignores it (#862), but
  the user's own terminal git follows it. Detect a `commondir` inside a main
  `.git` and offer to remove it.

## Phase 4 — keep the platform patched

- **#2329 Background update check.** Check once a day (network permitting,
  never on a metered or "headless connections off" setup). Show a quiet badge,
  or a clear one when the release notes mark it as a security release. Never
  install on its own (tier 0 "never automatic" stays).
- **#2329 Offline signing key** (same item): move the release key off GitHub
  (hardware key or an offline signing step in the release checklist), so a CI
  compromise can't sign.
- **#2330 Engine freshness check.** On startup, read the WebKitGTK and
  GStreamer versions (Linux) and warn when they're older than a floor kept in
  the binary. The warning names the package-manager command. Windows WebView2
  updates itself; macOS WebKit comes with OS updates, so only Linux needs this.

## Phase 5 — proof

- **#2331 Hostile-input suite.** A `tests/hostile/` folder: repos with planted
  `.git` config, hooks, `commondir`, `gitdir:` files, `latexmkrc`,
  `rust-toolchain.toml`, `.prettierrc`; mails with scripts, remote images and
  forged `Authentication-Results`; PDFs, ODTs, zip bombs, SVGs, notebooks.
  Each case asserts one thing: opening or viewing it runs nothing and writes
  nothing outside scratch. Run it in CI on Linux, Windows and macOS.
- **#2332 Fuzzing.** `cargo fuzz` targets for mail parsing, iCalendar,
  WebDAV XML, the git-config sanitizer and SFTP name confinement, all with the
  existing size caps.
- **#2333 Disclosure and an outside look.** Add `SECURITY.md` (how to report,
  what's in scope — link the threat model); reproducible release builds; an
  external audit or pentest before telling non-experts it is safe.
- **Live QA** of every "fixed, not live-verified" row, through the QA Runner.
  No new item needed: the manual boxes already exist on #861–#870.

## Order

1. #2321 (fence/X11) — possibly a live fence escape.
2. #869 remainder, #2322, #146 — small and already scoped.
3. #2323 — structural, can land window by window.
4. #2331 hostile-input suite — it proves 1–3 and every later phase.
5. #2324–#2328 — the product change; #2327 needs your decision first.
6. #2329, #2330 — patching.
7. #2332, #2333 — fuzzing and the outside audit last, once there is something
   stable to audit.

**Realistic outcome:** after steps 1–4, a typical engineer is well covered.
Recommending Tabtivity to a teacher needs Standard as the default, #2327 settled
on Windows, and #2333's outside audit done. macOS can't be compiled locally
(see the OS-support notes), so "safe on macOS" waits on CI plus a real Mac.

## Non-goals (kept invariants)

- Tabtivity does not pick or change an agent's permission mode (#2326 only shows
  it).
- Updates are never installed on their own.
- Out of scope stays out of scope: malware already running as your user, a
  compromised OS or engine, physical access to an unlocked machine.
- No telemetry to find out who runs which profile.

## Your calls

- #2327: container-required vs accept-once on Windows.
- #2324: should existing installs be *offered* Standard once, or left on
  Developer silently?
- #2321: `--unshare-net` changes what agents can reach (only their API hosts
  and loopback via the proxy). Is that acceptable in Standard only, or
  everywhere?
- #2329: where the offline signing key lives, and who can sign.
