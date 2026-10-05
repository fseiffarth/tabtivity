# Agent fence on Windows and macOS: match the Linux fence

Status: plan only (2026-09-27). Not implemented; implementation waits until
asked. Decisions the user made when this plan was written: **Windows = native sandbox accounts first, WSL2
as a later second backend**; **macOS = deny-default Seatbelt profile**.

---

## 1. Context

The Linux fence (`src-tauri/src/services/agent_fence.rs`, bubblewrap) is
Tabtivity's main agent boundary. It gives:

- (L1) a read wall: `$HOME` replaced by the scope's agent home, other projects
  and the private state dir masked;
- (L2) a write wall: only the project/box roots and the agent's own state are
  writable;
- (L3) the `.git` control files are read-only (`git_guard`);
- (L4) no keyring (Secret Service hidden, kernel keyring blocked by seccomp);
- (L5) private `/tmp` and `/run`, so no X11 or ssh-agent sockets;
- (L6) a pid namespace and a `kill` that reaches the whole subtree;
- (L7) fail closed; there is no off switch;
- (L8) network shared, loopback MCP endpoints reachable.

Where the other two platforms stand today:

- **macOS** has a Seatbelt fence (`sandbox_exec_profile`, `:1278`). It starts
  from `(allow default)`, which leaves three gaps against Linux:
  - Mach services stay reachable, so login-keychain items that trust
    `/usr/bin/security` can be read (L4). This is documented in
    `docs/context/agent_authority.md:366`.
  - `lsopen` and `appleevent-send` are allowed. `open -a Terminal x.command`
    or `osascript … do script` starts a program **outside the sandbox**. This
    is a real escape, and it is not documented yet.
  - `/private/tmp` is shared with the user and `SSH_AUTH_SOCK` stays usable,
    so the ssh-agent can sign for the agent (L5).

  It has never run on a Mac.
- **Windows** has no fence. `platform_fenceable()` is false, and the user
  accepts once that agents run with their full rights (`PlatformUnaccepted`,
  todo `group-o-security.md` #2327). AppContainer was rejected: it cuts
  loopback, and the exemption needs admin.

Goal: bring both platforms as close to L1–L8 as each OS allows, still fail
closed, and document every gap that remains.

## 2. How other open-source projects solve it (research, 2026-09)

| Project | macOS | Windows | Linux |
|---|---|---|---|
| **OpenAI Codex** (Apache-2.0) | `sandbox-exec`, `(deny default)` base policy in the style of Chromium, a mach-lookup allowlist, `.git`/`.codex` read-only | **Elevated:** one-time UAC setup creates `CodexSandboxOffline`/`CodexSandboxOnline` local users. The runner starts as that user and spawns children with a restricted token, and write ACEs are stamped on the workspace. Outbound traffic is blocked by firewall rules for the offline user. A private desktop is used by default. **Unelevated fallback:** a write-restricted token with a synthetic "sandbox-write" SID. There are 4 binaries (cli / setup / command-runner / child). | bwrap + Landlock/seccomp |
| **Anthropic sandbox-runtime** (`srt`) | `sandbox-exec`, deny default; mach lookups and the keychain denied; unix sockets allowlisted; violations read from `log stream` | Alpha. Setup creates one `srt-sandbox` user (DPAPI-encrypted password in HKLM) and a WFP egress filter keyed on its SID. There are two hops: `CreateProcessWithLogonW` starts a runner, and the runner starts the child with a restricted token in a job. **Additive, refcounted** ACEs are removed on `reset()`. Known gap: per-user tool installs (nvm, Scoop, `pip --user`) cannot be reached. Claude Code itself still requires WSL2. | bwrap + seccomp (AF_UNIX), netns + proxy |
| **Cursor** | Seatbelt | **Linux sandbox inside WSL2**. Their reason: native primitives "tailored to browsers". | Landlock + seccomp |
| **Microsoft MXC** (MIT, Build 2026) | `sandbox_init` SBPL, deny default | AppContainer in 3 tiers (the new OS `CreateProcessInSandbox`, Brokered File System, DACL), job UI limits, Win32k lockdown, firewall rules per package SID. The README says it is "not a security boundary" yet. | bwrap/LXC |
| **SandVault** | A separate macOS user (`sudo -u`) **plus** `sandbox-exec` | — | — |

Conclusions for Tabtivity:

1. **Windows:** a dedicated local account is the one approach that gives a read
   wall, a write wall and working loopback without AppContainer. Both big
   projects converged on it (Codex elevated, srt).
   - It needs one UAC prompt.
   - The known costs are per-user toolchain reachability (srt limitation 2),
     enterprise policies that strip "log on locally" (Codex error 1385), and
     Everyone-writable folders.
   - ConPTY cannot be passed through `CreateProcessWithLogonW` (microsoft/terminal
     #11865). The runner running as the account must own its **own** ConPTY
     and relay it, the same way Codex's command-runner does.
2. **Tabtivity needs something neither project needs:** isolation *between*
   projects. Codex and srt use one account for one workspace. With one shared
   account, project A's agent could read project B wherever B's ACL grants
   that account. So Tabtivity uses **a small pool of accounts, one leased per
   fence scope** (§4.2).
3. **macOS:** everyone serious uses `(deny default)` plus a mach allowlist.
   `sandbox-exec` is deprecated but still the only unprivileged, unsigned
   option, and Chrome, Codex, srt, Cursor and Gemini CLI all rely on it.

## 3. Design decisions

- **D1 One fence API, three backends.** `decide()` stays pure.
  - `platform_fenceable()` becomes true on Windows once the setup is present.
  - Without the setup, a new decision `FenceDecision::SetupNeeded` (Windows
    only) is returned. It is refused at spawn like `Unavailable`, and the
    frontend offers setup.
  - The accept-once path (`PlatformUnaccepted`) stays as the explicit fallback
    when the user declines setup or policy blocks it. The user can also
    withdraw the fallback.
- **D2 Parity target per property.** Each L-property is either met or listed as
  a gap in `agent_authority.md`. There are no silent gaps.
- **D3 Network parity with Linux** (L8): shared network, no egress filter.
  WFP/firewall rules are out of scope; they would be a separate, cross-OS
  "offline fence" feature.
- **D4 Additive, recorded ACL changes only** (Windows). Every ACE Tabtivity adds
  is written to a ledger in the state dir, and project removal, account
  eviction and uninstall take it back. Tabtivity never rewrites an existing DACL
  and never removes inheritance. This is how srt does it, and it keeps "Tabtivity
  never edits another app's config" honest: the grants are Tabtivity's own,
  reversible, and listed in Settings.
- **D5 WSL2 later** (§6). It gets its own phase once the native backend ships.
  The go/no-go checks in #2327 (c) stay the gate.

## 4. Windows: native sandbox-account fence

### 4.1 One-time setup (elevated, one UAC prompt)

`tabtivity.exe --fence-setup` is started via `ShellExecuteW("runas")`. It is a new
module `src-tauri/src/services/agent_fence_win/setup.rs`, AppHandle-free. It:

1. Creates the local group `TabtivityAgents` and a pool of N accounts
   `TabtivityAgent01..N` (N = 8, `Settings::agent_fence_pool_size`). Each gets a
   random 32-byte password, and all are hidden from the sign-in screen
   (`SpecialAccounts\UserList`).
2. Grants the pool "Allow log on locally". When a domain GPO strips that right,
   setup detects it and reports a clear failure (Codex #1385). It does not
   leave a half-installed state.
3. Hands the passwords back to the unelevated Tabtivity over an anonymous pipe.
   Tabtivity stores them encrypted with DPAPI (CurrentUser) under
   `<state_dir>/fence-win/accounts.json`. The state dir lives under the real
   profile, which no pool account can read.
4. `--fence-uninstall` (also elevated) deletes the accounts, group and
   profiles. The unelevated side first walks the ledger and removes every ACE.

Tabtivity's main process never runs elevated. The setup binary is the same
`tabtivity.exe` with a flag, so there is nothing extra to sign or ship.

### 4.2 Account lease per scope

- `<state_dir>/fence-win/leases.json` maps scope → account. It is stable, so
  the grants on a project are stamped once and not on every spawn.
- A new scope takes a free account. When none is free, it evicts the
  least-recently-used account that has no live tab: its ACEs are revoked, it is
  reassigned, and the grants are re-stamped.
- When all N accounts run live tabs, the spawn is refused: "All N agent
  accounts are busy — close an agent tab or raise the pool size in Settings."
- A box scope leases one account whose grants cover the whole box
  (`box_allowed_roots`).

### 4.3 What each account may touch (the Windows twin of the mount planner)

Reuse the existing planners (`agent_state_mounts`,
`configured_read_only_paths`, `command_bind_paths`, `private_state_paths`,
`git_guard::guard_paths`, `agent_install::fence_read_only_paths`). They turn
into ACE sets instead of bind mounts. There is a new pure function
`acl_plan(inputs) -> Vec<AceGrant>` with golden tests, which run on Linux too.

| Linux mount | Windows equivalent |
|---|---|
| roots rw | inheriting `MODIFY` ACE for **the scope's account**, with `FILE_DELETE_CHILD` withheld at the root itself (srt) |
| agent home over `$HOME` | `MODIFY` on `<state_dir>/agent-homes/<key>` for the scope's account. Env: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` all point inside it (per-scope temp = L5). |
| CLI installs, `bin/`, hooks ro | `READ\|EXECUTE` for the **`TabtivityAgents` group** (shared, stamped once) |
| `agent_fence_paths` allowlist ro | same group RX grant, but only for paths **under the user's profile** that the user confirmed in the setup dialog (toolchains: `.cargo`, `.rustup`, nvm/fnm, Scoop, `pip --user`). This is how srt limitation 2 is solved; the dialog lists each path. |
| `~/.gitconfig` ro | copied read-only into the scope home at spawn (no ACE on the user's own file), with `GIT_CONFIG_GLOBAL` pointing at the copy |
| private state masked | nothing to do: the state dir is inside the real profile, and the pool has no rights there (the read wall comes free) |
| other projects masked | inside the profile: already unreadable. **Outside the profile** (e.g. `D:\dev\B` inheriting `Authenticated Users` from the drive root): on each registered project root, an explicit deny-read ACE for **every pool account except the one leasing that scope** (not for the group: canonical order puts explicit denies before allows, so a group deny would lock out the owner too). A lease change rewrites these denies from the ledger. Spike S3 checks that it holds against inherited `Authenticated Users` grants. |
| `.git` control files ro (L3) | deny `WRITE\|DELETE` on each guarded file and deny `FILE_DELETE_CHILD` on `.git` for the scope's account (Codex marks `.git` read-only the same way) |
| Cargo credentials masked | deny-read on `credentials.toml` for the group |

The restricted token keeps `SeChangeNotifyPrivilege` ("bypass traverse
checking", on for Everyone by default). The account can therefore open
`C:\Users\<you>\proj\A` without having rights on `C:\Users\<you>`, and it
still cannot list that parent. This replaces the Linux ancestor-dir handling.

**Audit** (a Codex feature): at spawn, check each root's ancestors and each
granted path for `Everyone`/`Users`/`Authenticated Users` write ACEs that
would let the account escape or plant files elsewhere. If found, warn in the
fence pill; do not refuse.

### 4.4 Launch: runner relay (ConPTY cannot cross users)

```
Tabtivity ConPTY (portable-pty, as you)
  └─ tabtivity.exe --fence-runner <spec>        relays bytes + resize, as you
       └─ CreateProcessWithLogonW(TabtivityAgentNN, LOGON_WITH_PROFILE)
            └─ tabtivity.exe --fence-inner <spec>   as TabtivityAgentNN
                 ├─ job object: KILL_ON_JOB_CLOSE, UILIMIT_{HANDLES,READCLIPBOARD,
                 │   WRITECLIPBOARD,GLOBALATOMS,SYSTEMPARAMETERS,DESKTOP}
                 ├─ private desktop (CreateDesktopW), as Codex does by default
                 ├─ CreateRestrictedToken(own token: drop privileges except ChangeNotify)
                 ├─ own ConPTY → CreateProcessAsUserW(agent, PSEUDOCONSOLE attr)
                 └─ pipes to runner: framed {data, resize, exit}
```

- The spec is a JSON file written by Tabtivity into a per-tab dir that only the
  account can read (argv, env, cwd, size). No secrets go on the command line.
- The runner forwards console input (it sets raw mode) and
  `WINDOW_BUFFER_SIZE_EVENT` → `resize`. This is the same double-ConPTY shape
  `ssh.exe` already uses inside Windows Terminal.
- Phase 2 option if rendering suffers: a `PtyBackend::FenceRelay` in
  `src-tauri/src/terminal/mod.rs` talks to the pipes directly and skips the
  outer ConPTY.
- L6: `kill`/`kill_all` terminate the runner. The inner process notices the
  broken pipe and closes the job, and `KILL_ON_JOB_CLOSE` reaps the subtree.
  The Exit teardown (`RunEvent::Exit`) covers the runners like any other PTY.
- **Why a separate user and not only a restricted token:** anything the agent
  starts through a surrogate (Task Scheduler, BITS, out-of-process COM, WMI)
  runs as `TabtivityAgentNN` and stays fenced (srt's argument). It also cannot
  `OpenProcess` Tabtivity or other tabs, and it has its own HKCU, DPAPI and
  Credential Manager. That is the Windows twin of L4: the user's saved secrets
  sit behind the user's DPAPI key.
- **URL opening:** on a private desktop `start <url>` is invisible. Set
  `BROWSER` and add a `tabtivity-open` shim in `<state_dir>/bin` (the same shape
  as `tabtivity-send`) that asks the window to open the URL through the existing
  token-protected loopback endpoint. Agents' OAuth callbacks reach
  `127.0.0.1`, because user-based isolation does not cut loopback.

### 4.5 Code touch-points (Windows)

- New `src-tauri/src/services/agent_fence_win/`:
  - `setup.rs`: elevated setup and uninstall, account pool, logon right.
  - `accounts.rs`: DPAPI store and leases.
  - `acl.rs`: the pure `acl_plan` plus a `windows`-crate applier and the
    ledger, refcounted across concurrent tabs, with crash recovery on the next
    start.
  - `runner.rs`: `--fence-runner`/`--fence-inner`, job, desktop, token,
    ConPTY, framing.
  - `audit.rs`.

  Keep these modules AppHandle-free.
- `src-tauri/Cargo.toml` `windows` features: `Win32_Security`,
  `Win32_Security_Authorization`, `Win32_System_JobObjects`,
  `Win32_System_Console`, `Win32_System_StationsAndDesktops`,
  `Win32_NetworkManagement_NetManagement` (NetUserAdd,
  NetLocalGroupAddMembers), `Win32_Security_Cryptography` (DPAPI),
  `Win32_System_Pipes`.
- `agent_fence.rs`:
  - `platform_fenceable()` becomes `cfg!(linux|macos) || win_setup_present()`.
  - `fence_tool_name()`/`fence_unavailable_message()` get a Windows arm.
  - `bwrap_available()` on Windows means "setup present and the account logon
    probe works".
  - `wrap_pty_options_win()` is added next to the bwrap and sandbox-exec
    wrappers.
  - `one_shot_command` gets a Windows arm that runs through the runner without
    a ConPTY (git push preflight).
  - `live_unfenced_by_scope` gets a Windows arm: a tab leader whose token user
    is not a pool account is unfenced.
- `src-tauri/src/commands/terminal.rs:688`: add the
  `#[cfg(windows)] wrap_pty_options_win(...)` arm, and handle the new
  `SetupNeeded` decision next to `PlatformUnaccepted`.
- `src-tauri/src/services/home_io.rs`: the Windows path-based fallback is **no
  longer safe** once homes are writable by a less-trusted principal. Replace it
  with handle-relative I/O (`NtCreateFile` with `RootDirectory`,
  `FILE_FLAG_OPEN_REPARSE_POINT`, `FILE_DISPOSITION_INFO` for unlink,
  `SetFileInformationByHandle(FileRenameInfo)` relative to the held directory).
- `src-tauri/src/services/main.rs`/CLI entry: dispatch `--fence-setup`,
  `--fence-uninstall`, `--fence-runner`, `--fence-inner` before Tauri starts,
  next to `--agent-shim`.
- `agent_shim.rs:91`: Windows arm (a CLI typed into a shell tab goes through
  the shim into the same runner). The shims in `agent_bin` need `.cmd` twins.
- `schema/settings.rs`: `agent_fence_pool_size` and `agent_fence_win_paths`
  (the confirmed profile allowlist). The per-path grants themselves go in the
  ledger, not in settings.
- Frontend:
  - `src/stores/unfencedPlatformPrompt.ts` and `UnfencedPlatformDialog` become
    a choice: "Set up the agent sandbox (needs admin once)" (recommended) or
    "Run agents with my full rights".
  - The setup dialog lists the toolchain paths to share read-only.
  - Settings → Agent fence (`src/components/layout/SettingsSubPanels.tsx`)
    gains an accounts and leases view, the granted paths from the ledger, and
    Uninstall.
  - The fence pill shows the audit warnings. All strings go through `i18n.ts`.
  - An `UntestedTag` plus a `src/lib/untested.ts` row goes on every new
    surface.

## 5. macOS: deny-default Seatbelt

Rewrite `sandbox_exec_profile` (`agent_fence.rs:1278`). It stays a pure
function with the same `SeatbeltInputs` plus a few new fields. The base is
written fresh after Chromium/Codex. If any lines are copied from Codex's
`seatbelt_base_policy.sbpl`, keep its Apache-2.0 notice.

```
(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)  (allow ipc-posix-sem ipc-posix-shm)
(allow pseudo-tty) (allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(allow file-read*)                         ; then today's $HOME hide/restores, as now
(allow file-write* …roots, writable…)      ; today's write rules, unchanged order
(allow network* )                          ; L8 parity (shared network)
(deny network-outbound (remote unix-socket))            ; L5: no ssh-agent, no other sockets
(allow network-outbound (remote unix-socket (path-literal …allowlisted…)))
(allow mach-lookup (global-name
   "com.apple.system.opendirectoryd.libinfo" "com.apple.system.logger" "com.apple.logd"
   "com.apple.system.notification_center" "com.apple.SystemConfiguration.configd"
   "com.apple.SystemConfiguration.DNSConfiguration" "com.apple.trustd" "com.apple.trustd.agent"
   "com.apple.cfprefsd.daemon" "com.apple.cfprefsd.agent" "com.apple.diagnosticd"
   "com.apple.coreservices.quarantine-resolver"))
; not listed, hence denied: com.apple.SecurityServer / securityd (keychain, L4),
; com.apple.coreservices.launchservicesd (lsopen), pasteboard, windowserver,
; appleevent-send, lsopen.
```

- The exact mach list is spike **S5** (what node, Bun, Python, git, gh, cargo
  and each registry CLI need). `trustd` is a documented exfil concern (srt),
  but Go TLS (gh) needs it. Accept that and list it as a gap.
- **Keychain logins → file logins.** For each registry CLI that keeps its
  login in the keychain on macOS (Claude Code first), find whether it falls
  back to a file when `securityd` is unreachable, or whether an env switch
  exists (`agent_auth::fence_env` already carries per-CLI keyring-off
  switches). Any CLI with neither is refused in the fence with a clear message,
  never silently unfenced. That is spike **S6**.
- **Private temp** (L5): set `TMPDIR` to a per-scope dir under the stage dir.
  Keep `/private/tmp` writable for tools that hardcode it, but deny reads and
  writes of `/private/tmp/com.apple.launchd.*` (the ssh-agent and launchd
  listener sockets), and unset `SSH_AUTH_SOCK` in the fenced env.
- **Violation feedback:** a debug-only helper runs
  `log stream --predicate 'eventMessage CONTAINS "Sandbox" AND process == …'`
  so a denial that breaks a CLI can be named (srt). It goes behind
  `useExperimental`.
- Update `agent_authority.md:356–374`:
  - the keychain gap is closed;
  - the lsopen/Apple Events escape is named and closed;
  - the remaining gaps are `trustd`, no path redirection and no pid namespace.

## 6. Later phase: WSL2 backend (optional per machine)

Only after §4 ships, and only if the #2327 (c) go/no-go checks pass (bwrap
works in WSL2, interop can be killed inside the fence, `/mnt/*` hiding works,
loopback works under mirrored networking). Then:

- a project flag "Run agents in WSL" picks `wsl.exe -d <distro> -- <the Linux
  fence argv>`, reusing `bwrap_args` unchanged;
- `C:\` ↔ `/mnt/c` mapping sits in one helper used by `tabtivity-send`, git MCP
  and mobile control;
- Tabtivity-owned Linux agent installs go inside the distro.

It is a second backend under the same `decide()`, never a silent fallback for
the native one.

## 7. Ordered steps

0. (done) This plan lives in `docs/agent_fence_cross_os_plan.md`.
1. **Spikes, before code.** There is no Windows or Mac box here. Use the
   GitHub `windows-latest` and `macos-latest` runners (the Windows runner is
   admin, so setup can run) or a Windows VM.
   - **S1** An account created by NetUserAdd plus `CreateProcessWithLogonW`,
     then inner ConPTY and `CreateProcessAsUserW`, relays a TUI (`claude`,
     `vim`) with resize.
   - **S2** Job UI limits plus a private desktop still let node/git/cargo run.
     `start url` goes through the `BROWSER` shim.
   - **S3** The per-account denies on `D:\dev\B` hide it from the other
     leases while B's own account still reads and writes it (§4.3). The
     account can open a deep path under the real profile via traverse bypass.
   - **S4** Inheriting-ACE stamp time on a large repo (`node_modules`). If it
     is slow, stamp once per lease (already the design) and show progress.
   - **S5** macOS mach allowlist per CLI.
   - **S6** macOS keychain-less login per CLI.
2. **macOS profile** (§5): pure renderer and golden tests (run on Linux),
   `sandbox_exec_inputs` changes, `fence_env` additions, docs.
3. **Windows pure layer:** `acl_plan`, lease logic and spec format, with unit
   tests on every OS.
4. **Windows OS layer:** setup/uninstall, DPAPI store, ACL applier and ledger,
   runner/inner, `home_io` handle-relative I/O.
5. **Wire-up:** `decide`/`SetupNeeded`, `terminal.rs` arm, `agent_shim`,
   `one_shot_command`, `live_unfenced_by_scope`, status/pill, `.cmd` shims.
6. **Frontend:** setup choice dialog, Settings accounts/ledger/uninstall
   panel, audit warnings, i18n, UntestedTag rows.
7. **Docs:**
   - `agent_authority.md`: the macOS and Windows parity tables, and the
     rejected-AppContainer paragraph updated to name the chosen account
     design;
   - one row each for the new files in `docs/filemap_backend.md`;
   - user docs in `DOCUMENTATION.md` (find the spot with `rg`);
   - 🖐️ QA items in `todo/group-o-security.md` next to #2327, with
     per-platform ✅/❌ pairs.
8. **Later:** WSL2 backend (§6).

## 8. Verification

- Gates: `npm run build`, `npm test`, `cargo test`, `npm run lint`, `cargo
  clippy --all-targets -D warnings`. Also run a Windows type-check with the RC
  and lib shims (`cargo check --target x86_64-pc-windows-msvc`, see memory
  `project_windows_build`).
- **Pure tests (all OSes):**
  - golden Seatbelt profile: deny default first, no `securityd` or
    `launchservicesd`, protected denies after the allows, unix-socket deny
    present;
  - golden `acl_plan` for a project, a box, a root scope, a guarded `.git`, a
    profile allowlist;
  - lease eviction and "all busy".
- **CI integration tests** (`#[ignore]`, run by a job on `windows-latest` /
  `macos-latest`). Fenced, the agent:
  - cannot read `~/secret` or another project, and cannot write outside its
    root;
  - cannot write `.git/config`;
  - cannot reach `security find-generic-password` (macOS) or the user's
    Credential Manager (Windows);
  - cannot `open -a` or `osascript` (macOS);
  - loses its whole subtree on `kill`;
  - can reach a loopback HTTP server.
- **Live checks for the user** (Tabtivity is never launched by the agent):
  - Windows: accept setup → UAC once → open a Claude tab in project A → `type
    C:\Users\<you>\.ssh\id_ed25519` fails, `dir ..\B` fails, `git commit` in
    A works, the MCP help tool answers, closing the tab leaves no
    `TabtivityAgentNN` process in Task Manager.
  - macOS: open a Claude tab → `open -a Terminal` fails, `security
    find-generic-password -s "Claude Code-credentials"` fails, the agent is
    still signed in.
  - Tick the platform pairs.

## Sources

- [OpenAI: Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/)
  · [Codex Windows sandbox docs](https://learn.chatgpt.com/docs/windows/windows-sandbox)
  · [Codex Windows sandbox internals](https://codex.danielvaughan.com/2026/05/14/codex-cli-windows-sandbox-engineering-restricted-tokens-acls-elevated-architecture/)
  · [InfoQ summary](https://www.infoq.com/news/2026/06/codex-windows-sandbox-design/)
  · [Codex Windows sandbox PR #4905](https://github.com/openai/codex/pull/4905)
- [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
  · [Claude Code sandboxing docs](https://code.claude.com/docs/en/sandboxing)
- [Cursor: Implementing a secure sandbox for local agents](https://cursor.com/blog/agent-sandboxing)
- [MXC internals (Microsoft eXecution Containers)](https://www.originhq.com/research/mxc-execution-containers-internals)
- [SandVault](https://github.com/webcoyote/sandvault)
  · [Agent Safehouse: Codex sandbox analysis](https://agent-safehouse.dev/docs/agent-investigations/codex)
- [ConPTY with CreateProcessWithLogon (microsoft/terminal #11865)](https://github.com/microsoft/terminal/issues/11865)
- [sandbox-exec deprecation (apple/containerization #737)](https://github.com/apple/containerization/issues/737)
