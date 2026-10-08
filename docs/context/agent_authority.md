# Agent authority axes

Referenced from `AGENTS.md`.

**Agent authority has three axes Tabtivity owns**, and they compose: the project
container `sandbox` (OS containment), the tab's `location` (where the process
runs), and the default-on local-agent filesystem `fence`. All three are
properties of the *process* — where it runs and what it can reach — which is
what makes them Tabtivity's to decide.

A fourth thing looks like an axis and is narrower: the **root MCP caller
class** (`root_mcp::Caller`, `docs/context/root_console.md` §Mail). It is fixed
at spawn with the token and decides which of Tabtivity's *own* tools exist for an
agent — a root tab writes mail drafts and never reads mail; only a `Reader`, an
agent in a `mail_reader` VM whose egress is the default allowlisting proxy,
reads. It composes with the axes above rather than replacing them: the class is
only handed out where `location` is that VM.

## The permission mode is not one of them

An agent's permission mode — Claude's plan / accept-edits / bypass, Codex's
sandbox and approval policy, Gemini's approval mode — belongs to the agent, and
is set inside the agent's own CLI. Tabtivity launches the plain command and passes
no mode flag.

There was a fourth axis here: an experimental per-tab **Plan/Auto** toggle
(`agent_mode_toggle`, `components/tabs/agentModes.ts`, `TabEntry.agentMode`),
which folded `--permission-mode`/`--approval-mode` into the tab's `args`. It is
gone, and the two reasons it went are worth keeping written down, because they
are what a reimplementation would run into again:

- **A mode was a launch flag, so every flip respawned the PTY.** Changing a
  running session's mode meant killing it and relaunching it on `--resume`,
  which is survivable for the conversation and not for the terminal scrollback
  or a turn in flight. The agent's own in-TUI switch (Claude's shift+tab) costs
  none of that, because it never restarts anything.
- **It made the tab layout a second authority record.** A user who set a mode
  inside the CLI and a `TabEntry.agentMode` saying otherwise are two answers to
  one question, and the layout's answer is the one that got re-applied on
  restart — so Tabtivity could quietly put a resumed session into a mode nobody
  had asked for.

The mode a user sets in-session still survives a relaunch, but through the
agent rather than through the layout: `services::agent_session` re-applies the
mode Claude's own Stop hook recorded onto the `--resume` respawn (a shift+tab
cycle fires no hook event, which is why the record exists at all). An explicit
`--permission-mode` on a custom agent's argv outranks it, and anything outside
the known mode set is discarded.

Tabtivity Mobile is unaffected: the phone's mode sheet
(`mobile-web/src/terminal/agentModes.ts`) never used launch flags. It presses
Shift+Tab and verifies each step against the mode the TUI itself prints — which
is the same thing a person does, through the CLI. The desktop bridge's
`modes` list is now always empty, so a phone can no longer request a *launch*
mode; changing a running session's mode is untouched.

## The local-agent filesystem fence

### Reevaluation, 2026-09-26

The fence reduces filesystem access, but **does not currently provide a strong
boundary against a malicious agent**. Host-side consumers of agent-written
state belong to the boundary too. Per-scope homes alone do not make those
consumers safe. This review covered the Linux mount/filter planner, terminal
and shell-shim launch paths, global config writes, shared-login reconciliation,
and Copilot's keeper. It was not a full container, remote or MCP audit.

Confirmed and repaired using temporary fixtures:

- **Host file overwrite:** `agent_global::write_replacing` opened a predictable
  temporary name with `fs::write`. A symlink planted in a scope home caused the
  next global-config apply to overwrite its host target. Copilot's
  `write_private` had the same pattern. Both now use an exclusively created
  `NamedTempFile`, write through its handle and rename it into place. Claude
  identity writes and the credential-copy fallback also use this helper.
- **Host file disclosure through the login keeper:** a symlink at
  `.codex/auth.json`, or a `.codex` directory symlink, let `reconcile_home_in`
  copy host-only bytes into the shared login store. Tests reproduced both
  cases. Reconciliation now checks parent directories and uses an opened
  regular file with `O_NOFOLLOW | O_NONBLOCK` on Unix. Copilot's reads and
  directory checks use the same helpers. These checks reject planted links;
  they do **not** close the directory races below.
- **Owned CLI launch failure:** the final state mask hid `agents/install`
  after the early read-only allowlist mount. The install tree is now an
  explicit read-only support mount restored after that mask, with an argv
  ordering regression test. Actual mount execution was not possible here.

The four items that review left open were closed on 2026-09-26 (tracked in
`todo/group-o-security.md`; none run live):

1. **Parent-directory races in host filesystem operations — fixed.**
   `contained_path` (a checked path, then path-based I/O) is gone. Every
   unfenced write into a scope home — the global-layer apply and its
   manifest and backups, hook registration for Claude, Codex and Vibe,
   the login keeper, Copilot's keeper and settings, the scrub of the old
   fence's leftovers, the `.cache` mount point, and the one-time seeding
   (which an agent can force by deleting the seeded marker) — goes through
   `services::home_io`: the file's directory is opened once by an
   `openat(O_DIRECTORY | O_NOFOLLOW)` walk from the home, and reads,
   exclusive-temporary writes, `renameat`, `unlinkat` and `fchmod` are all
   relative to that handle. A directory the agent swaps for a link after
   the open moves with the handle; the write lands in it, never at the
   link's target. Adversarial tests rename the directory away and plant a
   link between the open and the write (`home_io`, `agent_global`,
   `agent_session`, `agent_home`). Windows keeps path-based checks behind
   the same API: it has no fence, so the race is not a boundary there.
2. **Writable host-installed CLI payloads — removed.** A CLI's install is
   read-only in every fence, whoever installed it: `updatable_install_dirs`,
   the Copilot `pkg/` payload and the private per-tab `~/.local/bin` copy
   with its carry-back (#861's machinery) are gone. The CLI's own updater is
   switched off for every fenced spawn where it has a switch (Claude's
   `DISABLE_AUTOUPDATER`); a CLI without one fails its update on the
   read-only tree and carries on. Updating a host-installed CLI is a
   reinstall through Manage CLIs (Tabtivity-owned from then on) or an update
   outside Tabtivity. This is the self-update widening of 2026-09-13 taken
   back: the payload was one every scope and the user's own shell executed
   next.
3. **Terminal injection from shell shims — the drain now covers the shim.**
   `agent_shim::run` no longer `exec`s into the fence: it runs the fenced
   CLI as its child on the same terminal, waits, and discards whatever is
   left in the terminal's input queue (`tcflush`) before the shell reads
   again — the same drain a fenced tmux pane runs before its trailing
   shell. Ctrl+C reaches the child (the shim ignores it while waiting, the
   child gets the default back); the child's exit status is passed through.
   On Linux the fence's pid namespace dies with the CLI, so nothing fenced
   can add to the queue after the drain; on macOS a process the agent left
   behind could, which is the limit the pane drain has there too. Denying
   the injecting ioctls at the fence's seccomp boundary was not done.
4. **Shared login integrity — mediated.** The per-CLI login store is no
   longer hard-linked into the homes: every home holds a **copy** at the
   CLI's own path, and the keeper (every 5 s, at every spawn and at every
   tab end) reconciles each home against the store. The store records,
   per home, the digest of what it last placed there (`.placed/`, in the
   store, where no agent can forge it), so a copy the tab changed — by
   rename or in place — is told from a copy the store has moved past. Such
   a write is adopted only through the account guard; a refused one is
   overwritten with the store's copy. A pass adopts from every home first
   and places into every home after, so a login made anywhere reaches every
   other home in one pass. A hard link from an older Tabtivity is replaced by
   a copy on the first pass. Login directories (Kimi, CodeBuddy) are
   reconciled file by file, only for the file names each CLI writes its
   login under (2026-10-08), and no longer bind-mounted. The cost is that a
   token refresh reaches the other running tabs one pass later instead of
   at once. Tests cover in-place and rename rotations, the refused account
   through both, the Host home, the hard-link migration and directories.

The existing network/environment limits also remain: inherited API keys are
not filtered, loopback/LAN/internet and abstract sockets are reachable, and
X11 access is still an unaudited route to host interaction (#2321). macOS is
a weaker filesystem-only boundary with reachable keychain services; Windows
has no OS fence. The review did not establish containment on either platform.

Three new regressions failed on the original code (temporary-link overwrite,
login-file disclosure, login-directory disclosure) and passed after the
repairs. Further tests cover Claude identity replacement, Copilot temporary
links and directory links, and owned-install mount ordering. The existing
kernel seccomp test also runs in the Rust suite. A standalone bubblewrap
probe failed with “No permissions to create a new namespace”, even outside
Codex's command sandbox, so no full fence or Tabtivity window was tested live.

### Current implementation

`services::agent_fence` is the third axis, and since 2026-09-25 (#2335) it is
the **only mode** a local agent runs in: there is no per-project or global
"off" any more. On Linux, a locally-running agent that is not already in a
project container is launched under an outer `bubblewrap` boundary. The host
root remains visible read-only so compilers and system tools still work;
`/tmp`, `/run` and `~/.cache` are private; the kernel keyring is denied (a
seccomp filter makes `add_key`/`request_key`/`keyctl` fail with `EPERM`, and
`/proc/keys` is masked) because Tabtivity's saved secrets are cached there in the
login session keyring every process inherits — the private `/run` alone hid
only the Secret Service, and until 2026-09-25 a fenced agent could read every
saved SSH, VPN and mail password; abstract Unix sockets outside the fence
are refused (`services::fence_scope`, since 2026-09-28): bubblewrap unshares
only the pid namespace, so the host's network namespace — and with it
`@/tmp/.X11-unix/X0`, the systemd/D-Bus buses and IDE daemons — stayed
reachable, and on an X11 host that ran `xhost +local:` or
`+si:localuser:$USER` a fenced agent could log keystrokes and type into
unfenced windows. Tabtivity's own binary (`tabtivity --fence-scope`) enters
Landlock's `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` and execs bwrap; sockets the
agent creates itself still work and the network is untouched. It is
best-effort per host — skipped below Landlock ABI 6 (Linux 6.12) or for a
setuid bwrap, where `no_new_privs` would strip bwrap's privileges — and fails
closed where used. `--unshare-net` would have closed the same hole but cut
the agents off the network; and `$HOME` is not the user's home
at all but the scope's **Tabtivity-owned agent home**
(`services::agent_home`, `<state_dir>/agent-homes/<project_key(scope)>/`),
bound over the home path. A local-model tab (`PtyOptions.local_model`) gets
the scope's second home, `<project_key(scope)>.local` — no scope key can
contain a `.` — so the config an `ollama launch` writes into its agent and
the sessions a local model runs stay apart from the scope's own agents';
same fence, same roots, seeded with only `.claude.json`. The owning project is mounted read-write. If it
belongs to project boxes, every box folder and member root is added
read-write; membership in several boxes produces the union. A `box:<id>` tab
receives that box's roots directly. Claude also receives `--add-dir` and
Gemini receives `--include-directories`, so their own working-dir checks
agree with the OS boundary. Codex receives no automatic `--add-dir`: that
flag requests extra writable roots, and Codex warns and ignores it when its
own effective permissions are read-only or managed. A root-console agent's
fence is `~/tabtivity/root` read-write and, only with
`root_fence_projects_readable` on (default off), every project, box folder
and remote mirror read-only through the allowlist's channel — a widening,
since one poisoned project can then reach the others through an agent with
open network.

**Why a home per scope, not per CLI, and not the user's.** Everything a CLI
keeps under `$HOME` — its config with MCP servers and hooks, its skills and
plugins, its transcripts and session stores, its folder-trust answers — now
lives in the scope's home. Every CLI of a scope shares the same writable
roots, so one home per scope adds no authority; but an agent in project A
must not be able to plant an MCP server, hook or skill that runs in project
B or in the root console (which holds the root MCP token) — the threat-model
gap 7 class — so the homes are per scope and other scopes' homes are
unreachable (the state dir is masked inside the fence; on macOS the whole
`agent-homes/` tree is denied and only the own home re-allowed). The user's
own `~/.claude`, `~/.codex`, `~/.gemini` and the rest are never mounted, so
the whole apparatus that used to protect them — the per-entry deny lists,
the staged shadow copies of hook-registration files, the credential mirror,
the per-project transcript stage and its harvest — is gone. Tabtivity registers
its session hooks in each home's `settings.json` / `config.toml` /
`hooks.toml` at every spawn, so it no longer edits another app's config. What
Tabtivity reads back out of a home (transcripts, Codex's SQLite, Copilot's
config) is agent-written and treated as attacker-controlled, as before.

A home is seeded once: the scope's existing Tabtivity-kept Codex store and
Copilot home move in, the Claude transcripts of the scope's own roots are
**copied** from the user's `~/.claude/projects` (so every tab open before the
change still resumes; the user's copy stays), and `.claude.json` gets its
identity keys plus the `projects` entries under the roots. Instructions,
skills, hooks and MCP entries of the user's home are not seeded per scope.
Forgetting or deleting a project deletes its home.

**The Tabtivity-wide layer.** Per-scope homes meant the user's own CLAUDE.md,
RTK hook and Codex MCP servers reached no agent; the user asked for "one
global Tabtivity" instead, and chose a layer over one shared home (2026-09-25),
because a shared home would give back exactly the gap-7 path above.
`services::agent_global` keeps a home-shaped tree at
`<state_dir>/agent-global/` that the user fills (Settings → Global agent
config: one-click import from `~/.claude`, `~/.codex`, `~/.gemini` without
logins, transcripts, folder trust or Tabtivity's own hooks; or "Open folder").
The import also takes the hook and plugin files the other CLIs read
(`.cursor/hooks.json`, `.factory/hooks.json`, `.vibe/hooks.toml`,
`.copilot/hooks/`, `.config/opencode/plugins/`, `.pi/agent/extensions/`,
`.gemini/hooks/`, every top-level `.md` of `.codex`/`.gemini`), so what the
user wired into their agents on their side — `rtk init -g --agent …` — reaches
every agent. Tabtivity never installs or registers such a tool itself: it comes
from the user's own setup, through this import (2026-09-26).
At every spawn, before Tabtivity's hooks are registered, its plain files are
copied over the home's (a scope file replaced the first time is kept in
`.tabtivity-global-backup/`) and its fragments of the files the CLIs write
themselves (`.claude/settings.json`, `.claude.json`, `.codex/config.toml`,
`.gemini/settings.json`, and the Cursor/Droid/Vibe hook files) are merged: objects recurse, arrays gain elements,
scalars take the layer's value. A per-home manifest records what was placed
and merged, so the next spawn first takes exactly that back out — a key the
user drops from the layer leaves every home, while a model a tab picked
stays. The layer is never mounted into a fence (it is in the masked state
dir, and in `private_state_paths` for Seatbelt), so a fenced agent can edit
only its own scope's copy, and the next spawn restores it. The writes go by
rename and refuse a symlinked directory inside the home: the home is
agent-writable and the merge runs unfenced.

**One login per CLI.** Credential files would otherwise have to be entered
once per scope (Cursor asked at every new tab; a login made inside a fenced
tab used to die with the tmpfs). `services::agent_auth` keeps each CLI's
login file once, in `<state_dir>/agent-auth/<cli>/`, and every home carries
a **copy** of it at the CLI's own path — until 2026-09-26 a hard link to the
store's inode, which let any in-place write reach every scope before the
account guard saw it (reevaluation item 4). The keeper (every 5 s, and at
every spawn and tab end) adopts a copy the tab changed — a login or refresh,
in place or rotated by rename — into the store, through the account guard,
and places the store's bytes into every other home; what it last placed per
home is recorded in the store (`.placed/`), which is how a tab's write is
told from a stale copy. Which paths are shared is the registry's
`auth_paths` column (`commands::agents`, Linux survey 2026-09-25): only
files that hold a credential and can never name a command. The survey missed
Pi: its `auth.json` runs a key that starts with `!` through a shell on every
read, so a fenced tab could have planted a command that ran in every other
scope and unfenced in the Host session (2026-09-26). The keeper now refuses
a Pi login whose key is not a literal (`agent_auth::names_command`) and shows
why in the Agents view, the same way as a refused account. A config that
mixes both (Continue's `config.yaml`, Crush's `crush.json`, Cline's
`providers.json`), a file the CLI loads as its environment (Vibe's
`.vibe/.env`, Aider's `.aider/oauth-keys.env` and `.env`, mini-swe-agent's
`.config/mini-swe-agent/.env`), a login in a database beside other state
(Kiro, Kilo, OpenClaw) or one in the keyring stays per scope. The dotenv
files and Cline's `providers.json` were shared until 2026-10-08 (threat
recheck gap 16): a fenced agent could write `GIT_CONFIG_*` →
`core.fsmonitor=<cmd>` into `~/.vibe/.env` and have it run in every other
scope's fence and unfenced in the Host session. There is no content
validator for them; they left the shared set, and those CLIs sign in once
per scope. At startup, before the import and the keeper,
`agent_auth::retire_shared_paths_in` drops their store dirs; every scope
and local-model home keeps the copy it holds, and the Host home loses its
copy where the bytes are the store's or what the store last placed there
(a copy that differs from both is the Host session's own write and stays).
Content planted before the fix stays in the fenced homes it already
reached. A user who wants one key everywhere puts the file into the
Tabtivity-wide layer (`<state_dir>/agent-global/`, "Open folder"), which no
agent can write; the store's copy is not moved there, since an agent may
have written it. Directories that hold a login (Kimi, CodeBuddy) are
reconciled file by file and only for an allowlist of names
(`agent_auth::DirNames`, read off the published bundles): Kimi's
`<name>.json`, CodeBuddy's `<authId>.info` minus its logout backups. A
temporary, a `.logged-out` marker, a backup or a planted file stays in the
home it was written in; the import copies the folder one level deep under
the same allowlist, and the startup cleanup removes unlisted names from the
store and a home's copy where it still matches what the store placed there.
Where a file names an account
(Codex's `account_id`; Claude's via the `.claude.json` identity the store
also keeps), the store records it at first adoption and a later file naming
another account is **not** adopted — the store's copy is put back over it,
Settings shows the refusal, and switching accounts is Sign out then log in
again (the same rule `copilot_auth` had). The fence also sets the per-CLI
"keep your login in a file" variables (`GEMINI_FORCE_FILE_STORAGE`,
`FACTORY_DISABLE_KEYRING`, …), since the keyring is not reachable inside
it. Settings → Agent fence → Agent logins imports a login this computer
already holds (the one safe direction) and signs out. An older Tabtivity's
Claude mirror (`agent-creds/`) is adopted into the store at startup. The
first start after the upgrade also runs both imports once
(`agent_auth::import_once`, `agent_global::import_once`, marker files in
the state dir): every login the store lacks, and the global layer if it is
empty — the user asked not to have to remember it. Never repeated, so a
Sign out or a file removed from the layer stays.

**Installs are read-only in the fence.** A CLI installed through Manage CLIs
goes into `<state_dir>/agents/install` (`services::agent_install`: the
installer's `HOME` plus the npm, bun, uv and pip prefixes), its launcher
dirs go on every tab's PATH ahead of host copies, and the tree is read-only
in every fence; updates run by installing again. A CLI the user installed
on the host is still detected, and since 2026-09-26 it is read-only in the
fence too — every hop of its launcher chain (`command_bind_paths`), never
its `~/.local/share/<tool>` payload read-write (reevaluation item 2; the
private `~/.local/bin` copy and carry-back of #861 went with it). The CLI's
own updater is switched off for every fenced spawn where it has a switch
(Claude's `DISABLE_AUTOUPDATER`); one without a switch fails its update on
the read-only tree and carries on. Updating such a CLI is a reinstall
through Manage CLIs or an update outside Tabtivity. Whether each vendor's
installer honours the prefixes is not verified per installer.

**Shell tabs.** They are still the user's terminals and are never fenced —
but a CLI typed into one now reaches the same fence: `<state_dir>/bin` holds
one shim per registry CLI at the front of every tab's PATH
(`services::agent_bin`), a script that execs `tabtivity --agent-shim <cli>`
(`services::agent_shim`), which builds the calling tab's fence from
`TABTIVITY_SCOPE` — same scope home, same shared logins — and runs it as its
child on the same terminal, draining the terminal's input queue once the
CLI has exited and before the shell reads again (reevaluation item 3).
`TABTIVITY_SCOPE`, `TABTIVITY_AGENT_FENCE` and `TABTIVITY_HOST_SESSION` are
only ever Tabtivity's: `launch_prep::prepare` drops each one (and the other
control variables) from a tab's incoming env and sets the scope itself, so a
persisted layout cannot name another scope or switch the shim off (gap 17).
Inside a fence the shim steps aside to the real CLI, skipping its own
directory only to *find* it: the CLI runs with PATH unchanged, so
`tabtivity-send` (same directory) stays reachable. Exporting the trimmed PATH
hid it from every fenced tab from 2026-09-25 to 2026-09-29. There is no bypass flag;
running the binary by absolute path is the user's own shell, real home, none
of Tabtivity's logins. `paths::resolve_executable` never returns a shim, so
version probes and the fence's own install binding see the real CLI.

**macOS and Windows.** Seatbelt cannot redirect a path, so a fenced Mac agent
gets `HOME=<scope home>` by environment with `GIT_CONFIG_GLOBAL`, `CARGO_HOME`,
`RUSTUP_HOME` and `DOCKER_CONFIG` passed through to the user's (only when
present and unset), the user's home hidden as before and the whole
`agent-homes/` tree denied except the own home. Windows has no fence; its
agent tabs still use the same Tabtivity-owned homes and shared logins through
`HOME`/`USERPROFILE`, with the user's full rights, accepted once
(`agent_fence_platform_accepted`). Neither is compiled or run here.

**The Host session.** For work that is not a project's — repairing Firefox,
the printer, the machine — a fence cannot serve (bubblewrap sets
no-new-privs, so `sudo`/`pkexec` fail). The root console's `+` menu has a
"Host session — unfenced" group: an agent with the user's full rights, warned
in the entry, a red HOST badge on the tab, never a project default, never
startable from the phone (its create path has no such flag). It runs in its
own home, `<state_dir>/agent-homes/host`, which no fence ever mounts, so
nothing fenced can plant config it runs; it shares the logins (credential
files only). After a restart it comes back **paused** — a "Resume unfenced"
card, never an automatic respawn (`TabEntry.hostSessionPaused`). The CLI's
own permission prompts apply; Tabtivity injects no mode. The decision is
`FenceDecision::NotApplicable { reason: "host session" }`, honoured only with
no `project_id`.

The configured `agent_fence_paths` allowlist restores selected toolchain and
config paths of the user's home read-only inside the agent home; credentials
are deliberately absent from its defaults. Independently of that list, the
fence follows the agent binary's own symlink chain on the host and binds
every directory hop under the user's home read-only (`command_bind_paths`):
the native Claude installer leaves `~/.local/bin/claude` pointing into
`~/.local/share/claude/versions/`, and with only `~/.local/bin` restored the
link dangles inside the sandbox and bubblewrap fails with `execvp claude: No
such file or directory`. Copilot signs in through the keyring, which the
fence hides; `services::copilot_auth` holds the sign-in in Tabtivity's own
keyring entry and hands it to each fenced Copilot as `COPILOT_GITHUB_TOKEN`
(its `~/.copilot` of the scope home gets Copilot's `storeTokenPlaintext`, the
keeper moves a `/login` token out of the file within seconds). A harvested
token replaces a stored one only once GitHub rejects the stored one.

Provider API keys (`services::agent_api_keys`, `docs/api_chat_plan.md` Parts
A and C) take the same keychain route: one key per provider under
`remote_credentials`' service (account `agent-key:<provider>`), never in a
file — and since C2 never in an agent process either. `services::api_proxy`,
a loopback listener of its own (started in `setup`, stopped in the
`RunEvent::Exit` teardown), holds the keys, cached in memory and re-read after
a save or remove. A keyed spawn gets a **proxy token** — 32 random bytes,
memory only, bound to provider + scope + tab — as the CLI's credential
variable (`ANTHROPIC_AUTH_TOKEN` for Claude, which takes it without its
custom-key dialog; `GEMINI_API_KEY`), and the CLI's base-URL variable
(`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) set plain to
`http://127.0.0.1:<port>/<provider>`. Only CLIs an environment variable can
point at the proxy keep a row (Claude, Gemini; Codex, Vibe and OpenCode are
out). The proxy refuses a browser request (`Origin`) or another `Host`,
needs a live token of the route's provider (`x-api-key`, `Authorization:
Bearer`, `x-goog-api-key` or `key=`, one value), forwards only the provider's
allowlisted paths (`/v1/messages`, `count_tokens`, `/v1/models`; Gemini's
`models/<m>:generateContent` family) and query parameters (`beta`, `alt`,
model-list paging — never `key` or a method override) to its one fixed HTTPS
host with the incoming credentials, hop-by-hop and method-override headers
and `accept-encoding` stripped and the real key added in the provider's
header, never follows a redirect, bounds the body (32 MiB, 256 MiB held over
all sockets), drops a socket idle for 60 s between requests (64 at most),
streams the answer through chunk by chunk, answers its own refusals in the
provider's error shape (`x-should-retry: false`), and logs nothing. A token
dies with its tab (`agent_fence::on_tab_gone` → `api_proxy::on_tab_gone`,
for the tab's newest spawn only: a kill that lands after a remount began
respawning the id is stale and leaves the respawn's token, see "Spawn
generations" below);
one bound to a local tmux session lives while that session does (a project
switch or reload kills only the client) — revoked when Tabtivity kills the
session, following a rename, and swept once a minute otherwise — a respawn of
the tab gets the same token back, and every token goes at quit — a clean quit
also ends Tabtivity's tmux sessions; after a crash a re-attached agent holds a
dead token, refused by the restarted proxy on the port it remembers
(`<state_dir>/api-proxy-port`), so its requests do not reach whatever else
took the port. Injection happens inside both fence wraps and in
`launch_prep`'s Host-session and fence-less-platform arms, only while the
proxy runs in that process — so the `agent_bin` shim (a CLI typed into a
shell tab, its own process) gets nothing and stays on its login. Only CLIs
listed in `agent_api_key_clis` get a token; never a remote, container or
local-model spawn, nor a subcommand (a sign-in tab); a credential or base URL
the user set wins. On Linux and macOS the token travels under an app-named
carrier (`<APP>_AGENT_SECRET_<VAR>`, `agent_api_keys::CARRIERS`), and only the
carriers are in `tmux_local::SECRET_ENV`: on no tmux argv or launcher script,
and the `update-environment` slots that stay on the user's default tmux server
name no variable of theirs. Tabtivity's own binary maps a carrier to the CLI's
variable and removes every carrier just before the agent runs
(`services::agent_exec`, `--agent-exec`; `--fence-scope` maps the same way):
the fence's first step in front of bwrap or `sandbox-exec`, in front of the
CLI for a Host session; Windows (no tmux) sets the CLI's name directly. That
step runs outside the fence, so a carrier sets only a CLI credential variable
(`agent_exec::targets`) — never `LD_PRELOAD`, `PATH` or `BASH_ENV` — and
every other mode of the binary drops any carrier it inherited at start. On
tmux < 3.2 every carrier is dropped rather than put on the argv, and the proxy
base URL beside it too. The unfenced login shell a fenced pane leaves behind
starts with `env -u` over every `SECRET_ENV` name; the Host session's (the
user's own shell) drops the carriers only. A keyed local Claude tab skips
`--remote-control`, which a gateway credential or base URL refuses. Gemini
still needs its own `/auth` pick. **What is left:** a project's own CLI
config (`ANTHROPIC_BASE_URL` in `.claude/settings.json`, Gemini's `.env`) can
still point the CLI at another host — which then receives only the token,
worthless off this machine and dead with the tab; and the agent can spend
through its token while the tab lives — up to the monthly limit (C3).

**Spawn generations** (gap 18, 2026-10-08). PTY ids are reused: a pane
remount respawns the same id while the unmount's un-awaited `pty_kill` is
still tearing the old PTY down. That teardown used to clear the respawn's
fence registration, API proxy tokens, MCP tokens and turn binding. Every
spawn now takes a sequence number in `launch_prep::prepare` before any grant
(`agent_fence::begin_spawn`); the PTY entry and its output route carry it,
`PreparedLaunch::commit` registers it (`register_tab(id, scope, seq)`, the
scope only for a fenced tab), and a spawn dropped uncommitted hands it back
(`abandon_spawn`). Every teardown names the spawn it ends
(`launch_prep::on_tab_gone(id, seq)` from `pty_kill`, `pty_kill_scope`,
`kill_all`; `agent_fence::on_tab_gone(id, seq)` from the reader task's end).
Only the id's newest spawn takes the shared per-tab state; a stale teardown
forgets its own registration and nothing else. The push preflight no longer
reads this registry at all: its fence scope rides on the push identity
(`docs/context/git_push_mcp.md`).

**Spending limit** (`services::api_usage`, `api_meter`, `api_prices`; plan
C3). A key is saved only beside a monthly USD limit
(`Settings::agent_api_limits`; `agent_api_key_set` refuses without one). The
proxy meters every billed request (Anthropic `POST /v1/messages`; Gemini
`generateContent`, `streamGenerateContent`, embeddings — counting and model
reads are free and never refused) in its `usage_tap`/`usage_end` seam: a
streaming JSON scanner with bounded state reads only the usage object of the
top-level answer (Anthropic `usage` at the root or under `message`, Gemini
`usageMetadata` at the root of each response) — a `usage` key inside a tool
call's arguments or the text is never read, so an agent cannot make the model
print a cheaper usage; counts are cumulative, so each field keeps its maximum;
what was reported is charged when a stream fails or the client leaves, plus
an estimate for what was not (an Anthropic answer without its
`message_delta`, a Gemini stream that did not end cleanly, a request the
client left before its answer began — the handler's `Pending` guard —, an
unreadable usage object): output by elapsed time at
`ANTHROPIC_TOKENS_PER_SEC`/`GEMINI_TOKENS_PER_SEC`, capped by the request's
`max_tokens` (Anthropic) or the provider's output cap, unreported input as
body bytes / 3 up to a context window, the request's fast/US flags — so an
agent cannot read an answer and hang up before its count to spend for free.
An answer naming two models (server-side fallback) is priced at the dearer.
The
model comes from the answer (Gemini: `modelVersion`, else the request path);
one the table does not know is priced at the provider's highest current rate
and flagged. The ledger (`agent-api-usage.json`, no secrets, UTC month) is
in-process memory written atomically (throttled, and in `stop_for_exit`); a
clock that goes back keeps the later month; a corrupt file is moved aside and
the restart is shown, never silent. Enforcement sits after the key check and
before the body is read: spent ≥ limit, or no limit set (a key saved before
limits existed), answers 429 in the provider's shape (`rate_limit_error` /
`RESOURCE_EXHAUSTED`, `x-should-retry: false`) naming the app's budget and
Manage CLIs. Requests in flight count (gap 9, 2026-10-04, not live): after
the body is read each billed request reserves its worst case
(`api_meter::Meter::worst_case` — whole output cap, input bytes/3 as 1-hour
cache writes — the model's whole context window when the body names input
by URL, file, cache or a fetch/search tool (#2343 follow-up, 2026-10-05,
`names_input_by_reference`) — ten grounding queries if a Gemini body may
ground) in
`api_usage::Book::reserve`; spent + held + this one past the limit answers
429 (same shapes, a "could cost more than is left" message). The
`Reservation` drops after the actual charge, or with the meter on a connect
error, an upstream failure or a client that leaves — it never outlives the
request; reservations are memory-only (micro-dollars), the ledger file is
unchanged. The overshoot is now only what an answer costs past its
reservation. The limit is read from `settings.json` per request (re-parsed
when its mtime or size changes, and at least every 10 s), so raising it takes
effect at once. Gemini Search/Maps grounding is metered (gap 8): the meter
counts `candidates[i].groundingMetadata.webSearchQueries` (keyed hash per
query and candidate, max over responses), priced per query ($14/1,000, 3.x)
or per grounded prompt ($35/1,000, 2.5), unknown models $35/1,000 per query;
an unsettled answer whose body may ground counts at least ten. Not metered:
spend outside Tabtivity — the help recommends a provider-side limit too.

Composition is explicit:

- A project container is already the stronger boundary, so the fence is skipped.
- An agent running over SSH is outside the local kernel's reach, so the fence is
  not enforced and the UI says “remote host”. A local-only tab of a remote project
  runs in and is fenced to its local mirror.
- macOS enforces through a `sandbox-exec` Seatbelt profile built from the same
  mount planners as the Linux fence: writes are denied outside the roots and
  the agent's own state, the rest of `$HOME` is hidden. Seatbelt can deny but
  not redirect, so the agents' hook-registration files are read-only there
  (an agent rewriting its own `settings.json` gets `EPERM`) instead of shadowed
  by a throwaway copy, and `~/.claude.json` is exposed unfiltered rather than
  as the per-project filtered copy Linux stages. Device writes are denied too,
  except `/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/dtracehelper` and
  `/dev/fd`; other terminals' `/dev/ttys*` stay denied, so a fenced agent cannot
  write into another tab's terminal.
- The macOS fence is a filesystem fence only. The profile starts from
  `(allow default)`, so mach services stay reachable — `securityd` among them.
  A fenced agent can therefore ask the keychain for any item whose access list
  trusts the requesting tool (`/usr/bin/security` included), which is how the
  agents sign in at all. The Linux fence hides the keyring (Secret Service and
  kernel keyring alike); the macOS one cannot
  without breaking agent authentication, so treat login-keychain items as
  reachable from a fenced Mac agent. The keychain *file* itself stays unreadable
  (it sits under the hidden `$HOME`).
- Windows has no fence; the status says so rather than presenting a false
  guarantee, and the first local agent spawn is refused
  (`FenceDecision::PlatformUnaccepted`) until the user accepts once that
  agents there run with their full rights (`agent_fence_platform_accepted`).
  AppContainer, the one unprivileged sandbox Windows offers, was rejected: it
  cuts loopback for the contained process unless an admin adds an exemption,
  and every Tabtivity MCP endpoint (`root_mcp`, git push, schedule, help), the
  local-model endpoint and the agents' own OAuth callbacks are `127.0.0.1`.
  It also blocks Credential Manager and `%TEMP%`. Low integrity / restricted
  tokens block writes but not reads, and hidden reads are the point. The
  candidate for a real Windows fence is the Linux fence unchanged inside
  WSL2 — see todo #2327 (c) for what must be verified first.
- Shell/script tabs are the user's terminals and are never fenced; a
  registry CLI typed into one runs through the shim, fenced (above).
- A persistent (tmux) agent tab keeps an **unfenced** login shell after the
  agent exits, on the same terminal. Where the kernel still honours `TIOCSTI`
  (Linux before 6.2 or with `dev.tty.legacy_tiocsti=1`, macOS), a fenced agent
  could queue keystrokes on its own terminal and exit, and that shell would run
  them. So the pane drains the input queue between the two
  (`tmux_local::FENCE_INPUT_DRAIN`). bubblewrap's `--new-session` would block
  `TIOCSTI` at the source, but it detaches the agent from its controlling
  terminal, so it never gets `SIGWINCH` and a TUI stops reflowing on resize.

Fenced Linux Codex gets no sandbox-backend override. Its own bubblewrap
cannot nest under the fence on Ubuntu: the outer bwrap runs under the stacked
`bwrap//&unpriv_bwrap` AppArmor profile, which denies the uid-map write of a
second user namespace (`unshare -Ur` fails inside the fence, so does a nested
`bwrap`). Tabtivity briefly forced Codex's Landlock backend instead
(`-c features.use_legacy_landlock=true`, 2026-09-14), but Codex 0.154.0
prints a deprecation warning for that key on every start and its legacy
backend refuses workspace-write outright ("permission profiles requiring
direct runtime enforcement are incompatible with --use-legacy-landlock")
unless `sandbox_workspace_write.exclude_slash_tmp` is also set — a policy
narrowing Tabtivity must not choose for the agent. So the flag was dropped
(2026-09-15): inside the fence Codex's sandbox fails to spawn, Codex reports
that and asks to run the command outside its sandbox — which is still inside
Tabtivity's fence — and the user answers per command or once per session. The
Landlock opt-in that used to be suggested here is gone too: Codex's
linux-sandbox README (checked 2026-09-28) says the legacy Landlock backend was
removed and `features.use_legacy_landlock` must be turned off.

Letting Codex's bubblewrap nest was re-evaluated on 2026-09-28 (Ubuntu 26.04,
bubblewrap 0.11.1) and rejected, because it cannot be limited to the fence:
- Nothing inside the fence can widen it. The agent runs as
  `bwrap//&unpriv_bwrap` with `NoNewPrivs: 1`. Under no-new-privs AppArmor
  only allows transitions to a stack that keeps the current label, and
  `unpriv_bwrap`'s `audit deny capability` outranks any allow, including one
  in `local/unpriv_bwrap`. A profile "for Codex's bwrap only" is therefore
  impossible.
- Tabtivity cannot start its outer bwrap under a looser profile either:
  `kernel.apparmor_restrict_unprivileged_unconfined=1` stops an unconfined
  process from `change_onexec`-ing into a profile that allows user namespaces.
- What is left is a profile attached to a root-owned launcher path. Every
  process of the same uid can exec that launcher with arbitrary arguments, so
  it reopens capable user namespaces for the whole account (browser included).
  That is the aa-exec/busybox bypass class Ubuntu closed in 2025, not a
  fence-only exception.
- Even with the namespace allowed, a nested `bwrap --proc` would probably
  fail: the fence's `/proc` carries bwrap's read-only overmounts
  (`/proc/sys`, …), which become locked in the nested namespace and fail the
  kernel's `mnt_already_visible` check. This part is inferred, not run.

The way out that keeps a check on each escalation is Codex's own: auto-review
(`approval_policy = "on-request"` with `approvals_reviewer = "auto_review"`),
where a reviewer agent answers the sandbox-boundary requests instead of the
user. Whether it covers the "sandbox failed, retry outside it" request fenced
Codex raises is not confirmed. Manage CLIs has a switch for it on the Codex card
(`agent_global::set_codex_auto_review`). The switch writes
only `approvals_reviewer` into the layer's `.codex/config.toml`. The approval
policy stays Codex's; auto-review needs `on-request`, Codex's default. So this
is the user's own Codex config reaching every home, not a mode Tabtivity picks.

The fence-tool probe caches success, but retries failure on the next request.
Installing bubblewrap therefore allows the next tab to start without restarting
Tabtivity. The project menu reports the policy for **new spawns**, not an inspection
of already-running tabs; existing tabs retain their original mounts/profile.

Cargo toolchains remain readable, but `credentials` and `credentials.toml` under
`~/.cargo` and an inherited or tab-specific `CARGO_HOME` are hidden by default.
Linux masks existing files after all root/toolchain mounts; macOS adds final
read/write denials, including canonical aliases. The global
`agent_fence_cargo_credentials` opt-in restores the prior visibility through
allowed paths when publishing needs registry tokens. It does not filter
inherited environment variables or touch agent login credentials.

Every CLI's `skills`, `plugins`, hooks and shell snapshots are simply files
in the scope's own home now: an agent may rewrite them, and the rewrite runs
in that scope's fence and nowhere else. This does not turn the fence into
project confidentiality: the scope's own transcripts are readable to every
CLI of the scope, and readable host trees outside the hidden home can still
be visible.

The boundary is filesystem-only: network access is shared. A nested bubblewrap
cannot run under the outer boundary on Linux systems with the
`bwrap-userns-restrict` AppArmor profile, so Claude Code's own bubblewrap sandbox
falls back to unsandboxed execution *inside* Tabtivity's outer fence. Docker commands
also cannot work there because `/run` is private and the Docker socket is hidden.
The agent-state mounts deliberately reuse `services::sandbox`: narrowed auth and
resume state, immutable hook scripts and `<state_dir>/bin` commands (including
`tabtivity-send`, prepended to PATH inside containers too), writable staged copies of hook-registration
config, and per-root Claude transcript permissions. That keeps the hook-repointing
and cross-project transcript protections identical across the two containment
mechanisms.

What the Linux fence does and does not stop (code read 2026-09-25, not tested
live). **Network:** `bwrap_args` has no `--unshare-net`, so a fenced agent
reaches loopback services (Vite, Ollama, CUPS, Tabtivity's MCP server, which
relies on its bearer tokens), the LAN, the internet and cloud metadata. That is
intended. **Home:** the scope's agent home, never the user's; `~/.cache` a tmpfs.
**Host processes:** `--unshare-pid` plus a fresh `--proc` mean
`/proc/1` is the fence's own bwrap. Host PIDs are absent, so there is no
`/proc/<host-pid>/root` to walk into. **Inherited descriptors:** none cross.
`portable-pty` closes every fd above 2 before exec (`close_random_fds`), Rust
opens files close-on-exec, and tmux closes stray fds in the panes it spawns.
**Environment:** not filtered (no `--clearenv`). An API key exported in the
shell that launched Tabtivity reaches every fenced agent. **Display:** `DISPLAY`
is kept, and the abstract X11 socket is reachable through the shared network
namespace. Hiding `/tmp/.X11-unix` does not close it (#2321). On a Wayland
session only Xwayland clients are exposed, because the Wayland socket under
`/run/user` is hidden.

**A layout written before the toggle was removed still carries its `agentMode`,
and `loadFromLayout` ignores it.** No migration strips the field: the frontend
no longer projects it, so the next layout save overwrites the entry without it.
Nothing reads it in the meantime, so a stale `"agentMode":"auto"` in an old
`terminals.json` cannot put a restored tab into a mode — which is the property
the removal was for.
