# Threat-model recheck 2026-10-24 — findings and fix plan

Status: **steps 1–26 implemented, none live-verified (gap 51 mitigated, not
fixed); step 27 (docs) done.** See "Implementation notes / deviations" below.
Three read-only reviewers (A, B, C)
re-checked `docs/threat_model.md` against the code at `21eadf64`, then
cross-reviewed each other's drafts at `ff9f83ab`. The last recheck landed at
`eacfa41a` (2026-10-13); since then ~470 commits added the assistant (Tabby)
and its web lane, OpenAI/Codex/OpenCode through the API proxy, OpenCode 2,
phone worktree moves, cloud-session teleport, phone Tabby, remote-host tabs on
the phone, and server-mode confinement work. Raw reviewer material (brief,
drafts, cross-reviews, every `file:line`):
`docs/threat_recheck_2026_10_24_handoff.md` (`rg -n` only, never whole).

The new gaps are rows 42–64 of `docs/threat_model.md` ("Gaps found
2026-10-24"). No earlier fixed gap regressed: rows 1–41 that fall in the three
areas were re-checked, and their defences are present at HEAD. Some row texts
are stale; step 27 rewrites them.

| Reviewer | Area | New findings |
|---|---|---|
| A | Agent fence, homes, shared logins, Tabby + web lane, API proxy, OpenCode 2, MCP lanes, exec_trust, hardened git | 1 high, 4 medium, 3 low |
| B | Phone sidecar + PWA, remote-host tabs, sync, lockstep, VPN, server mode | 4 medium, 6 low, 3 info |
| C | Webview perimeter, viewers, mail/CalDAV, credentials, supply chain | 6 medium, 5 low |

## Findings

Severity agreed by all three reviewers unless noted. "You do" is the threat
model's tier. Evidence is abbreviated; the handoff has the full citations.

| Gap | From | Sev | Finding (evidence) | You do | Confidence |
|---|---|---|---|---|---|
| 42 | A1 | **high** | **The shared OpenCode login carries configuration.** `auth_paths` shares `.local/share/opencode/auth.json` (`commands/agents.rs:258`); the keeper adopts a changed copy from any scope and places it in every home, the Host and assistant homes included, checking content only for Pi and the Codex/Claude account guard (`agent_auth.rs:220-316,1000-1011`). OpenCode reads a `wellknown` entry as an integration: 2.x imports it once per home database (migration `import_legacy_credentials`) and then fetches that origin's remote config (MCP servers, plugins, permissions) at every start; 1.x sets an environment variable from it. One fenced agent reaches every other scope's OpenCode, an unfenced Host-session OpenCode and the Tabby OpenCode chat (past its pinned tool set); headless sidecar launches run the same `reconcile_home_in`, so phone-started tabs too. Once imported it persists in SQLite. Gap 16's residual ("credential-only") is wrong for OpenCode. | start OpenCode in another scope, the Host session or Tabby (3) | Tabtivity side confirmed; OpenCode side from the installed 2.1.2/2.1.3 binaries' strings. **Fixed, not live-verified.** |
| 43 | B10 | medium | **Fixed, not live-verified.** **"No shells on the phone" does not hold for local agent tabs.** After a fenced agent exits, its tmux pane runs a trailing login shell *outside* the fence (`tmux_local.rs:383-398`). The phone lists the tab by its saved kind (`discovery.rs:1825-1850`) and the bridge writes input frames as they come (`pty_bridge.rs:820`). A paired phone ends the agent, then has a full unfenced shell, with ordinary UI input, in the default configuration. Predates `eacfa41a`; not in the model. | — (paired or stolen phone) | confirmed |
| 44 | B11 | medium | **Fixed, not live-verified.** **`prefix None` does not keep phone input in the pane.** tmux's default root-table right-click / Alt+right-click pane menu (split, respawn) stays bound in Tabtivity sessions (`mouse on`, no `unbind`/`key-table`: `tmux_local.rs:625-661`, `ssh_exec.rs:458-470`); the bridge forwards raw mouse reports. The real PWA sends none (`disableStdin`), but a stolen phone or any client holding a session can: an unfenced local shell, or a host shell on a remote-host tab with `shell_tabs` off. Contradicts `docs/context/root_console.md:852-859`. | — (stolen phone, crafted input) | Tabtivity side confirmed; tmux side from the 3.6 binary's key table |
| 45 | B2, C10 | medium (dev builds) | **The browser desktop client is served from the fence-writable checkout.** `bundle_dir` prefers `SOURCE_ROOT/web-dist` (`web_client.rs:725-735`), read from disk on every request with inline-script hashes taken from that `index.html` (`:951-980`). `web-dist/` is gitignored and rebuilt by any `npm run build`, an agent's included. Opening the client then runs agent script with a `Role::Admin` session of the unfenced sidecar. Also, pre-auth `assets/*` are read with link-following `is_file()`/`fs::read`, no cap (`:939-962`), and fenced agents share the loopback network: with Browser access on, an agent can read any user-readable file through the sidecar with no user action. The sibling of what gap 20 removed for the phone app (`live_pwa`); not covered by the C3 residual (no commit, build or relaunch needed). | open the browser client / nothing (Browser access on, dev build) | confirmed. **Fixed, not live-verified** (step 2: a dev build embeds `web-dist/` via `build.rs` `WEB_ASSETS`, no checkout read; directory bundles open no-follow, regular, capped; needs a full `package-dev` pass). |
| 46 | B1, B5 | medium | **Background auto-sync pushes through a symlinked mirror file.** `sync_auto` stats candidates with `fs::metadata` and `push_file_atomic` reads by path (`sync_auto.rs:647-660`, `remote_sync.rs:1437-1445`); only the manual walk uses lstat. A fenced agent swaps an already-synced file for a link to a host file it cannot see (SSH key, CLI login); the next unattended pass uploads it to the remote host. A FIFO there blocks a runtime thread while the project's sync lock is held, stalling lockstep too. Files over 64 MiB are still skipped with only a log line. | 1 (auto-sync set up) + 3 | confirmed |
| 47 | C9 | medium | **Folder copy follows links inside the tree.** `copy_recursive` uses `is_dir()`/`fs::copy` below the top level, no special-file check, no cap (`commands/fs.rs:1423-1434`). Reached by the file tree's Copy/Paste, the cross-device move fallback and `import_external_file` (OS drop, Downloads, the new clipboard paste `42a848c4`). A link an agent planted makes the unfenced app write the target's contents into the project. | 2 (copy/paste/drop a folder) + 3 | confirmed. **Fixed, not live-verified.** |
| 48 | A2 | medium | **OpenAI through the proxy: spend the meter cannot see.** `/v1/responses` bodies are forwarded as they are (`api_proxy.rs:1271-1275`); the meter reads `model` and `max_output_tokens` only (`api_meter.rs:683-686`). A `background: true` request returns before usage exists, is charged a small elapsed-time estimate, and is billed in full later — unbounded past the monthly limit. `service_tier` priority is priced as standard; server-tool fees (web/file search, code interpreter, image generation) are never charged; `OpenAI-Organization`/`OpenAI-Project` headers pass through. | nothing (keyed Codex/OpenCode tab, injected) | confirmed in code; OpenAI billing from its docs. **Fixed, not live-verified.** |
| 49 | A6, C7 | medium | **Agent-written SQLite stores are opened without guards.** `opencode_store::open_store`, `codex_store` and `token_stats::codex_db_threads` open DBs in the agent-writable home by path, read-only only: no no-follow, regular-file check, `trusted_schema` off, deadline or length limit (`opencode_store.rs:66-67`, `codex_store.rs:96-191`, `token_stats.rs:733-756`); `google_chat::database` checks then reopens by name (`google_chat.rs:199-208`). A FIFO parks a runtime worker on the spawn path (`launch_prep.rs:847-851`); a view-based schema pins CPU or exhausts memory and can abort the app (which then enables gap 50b). | open the tab or its Reader (0–3) | confirmed; view DoS plausible-high **Fixed, not live-verified.** |
| 50 | A7, C4, B14 | medium | **Loopback ports are trusted by address, not owner.** (a) Ollama: `mail_ai::resolve_endpoint` accepts any loopback listener, and gap 25's "is it local?" check asks that same listener (`mail_ai.rs:126-136`, `ollama.rs:1124`, `root_mcp.rs:3602-3608`). Whoever binds it while Ollama is down — a fenced agent (same uid, shared netns), another local user, another tenant on a hosted server — gets mail bodies (auto-classify), completion buffers and local-model mail reads, and answers the local-only gates itself. (b) After a crash, a surviving fenced agent can bind the API proxy's remembered port (`api_proxy.rs:817-834`); other surviving keyed agents then send it their conversations and take its answers as model output. (c) Desktop OAuth-callback delivery from the phone is not owner-checked (`sign_in.rs:141-160`, server only). | nothing / open mail; a crash | code paths confirmed; timing plausible **Fixed, not live-verified.** |
| 51 | C1 | medium (model gap) | **App windows render hostile bytes in an unsandboxed renderer on Linux.** wry 0.57 never enables WebKitGTK's sandbox (`commands/browser.rs:78-100`); `fb6232f1` covered only live browser pages. `main`/`detached-*`/`present-*` hold the full IPC bridge and parse PDF embedded fonts (pdf.js `FontFace` on, `pdfLoad.ts:48`), images, SVG, media and the HTML preview — including pictures and PDFs an agent reply names in the desktop chat (no click). A WebKit memory bug is full compromise with no second escape. The model calls WebKitGTK out of scope. | 2 (open a file) / 3 (agent reply) | config confirmed; needs an engine bug. **Fixed, not live-verified** — mitigated (`disableFontFace`); sandboxed `webkitgtk-6.0` route tracked (`docs/browser_plan_b.md` §8.6). |
| 52 | C3 | medium | **IDE detection reads project files unbounded, automatically.** Every project shown in the side panel runs `detect_project_ides` (`IdeMenuItems.tsx:39-44`); `jetbrains_product` reads `*.iml` with link-following, uncapped, blocking `read_to_string` (`ide_detect.rs:498-531`). A hostile repo or a fenced agent can abort the app or park threads. | 0–2 (show a project) | confirmed. **Fixed, not live-verified.** |
| 53 | C2 | medium (Windows), low elsewhere | **SyncTeX canonicalizes paths a hostile map names.** `Spelling::absolutise` runs `canonicalize` on every `Input:` path, before filtering to the document's tree (`synctex.rs:611-636,719-723`). On Windows a UNC path is opened: a click in a hostile repo's PDF contacts a network host with the user's sign-in (the class gap 38 closed for markdown). | 2 (click-sync) | code confirmed; Windows behaviour plausible. **Fixed, not live-verified.** |
| 54 | A5 | low | **OpenCode 2's background service shares one fixed loopback port across homes.** Typed `opencode` (agent shim, Host session) does not get `--standalone` (`agent_shim.rs:51-109`; Tabtivity's own launches do, `launch_prep.rs:979-984`). The first home to bind 49374 blocks every other home's service; a fenced squatter could plausibly pose as another home's server to a client with a stale registration. | type `opencode` (2–3) | ports/auth confirmed from strings; impersonation plausible **Fixed, not live-verified.** |
| 55 | A3 | low | **The Claude Resume menu follows a linked folder** in the agent-writable home (`agent_chats.rs:291-319`, `agent_session.rs:418-425,683-689`): another scope's conversations listed and opened in this tab's Reader. Display only; desktop only. | open the Resume menu (2) | confirmed **Fixed, not live-verified.** |
| 56 | A4 | low | **Path-shape checks trust agent-writable shapes.** The O#149 cwd gate is lexical (`launch_prep.rs:484-486`, `sandbox.rs:1739-1741`); `agent_relocate::is_agent_folder` accepts a linked `.tabtivity/worktrees/<name>` (`agent_relocate.rs:105,233-245`); `git_guard` binds a worktree's `.git` pointer without the `inside(roots)` check (`git_guard.rs:77-94`). Under bwrap none widens writes. | open/relocate a tab | confirmed; impact minimal **Fixed, not live-verified.** |
| 57 | B6 | low | **Fixed, not live-verified.** **Tabby ignores per-phone lists and is on by default** with the experimental flag (`discovery.rs:752-791,1262-1263`): a phone narrowed to no projects reads Tabby chats and starts chats next to every shared login. | — (paired phone) | confirmed |
| 58 | B4 | low | **Phone data outlives revoke.** On `unpaired` the PWA only forgets its last place (`App.tsx:335-336,455-457`); covers (up to 600 pictures/PDF first pages), markup layers with the PDF's words, drafts and held prompts stay in IndexedDB/localStorage. | — (lost phone) | confirmed. **Fixed, not live-verified** (`forgetDeviceData()` on a definite `unpaired`; covers dropped when the host says `project_not_found`). |
| 59 | B3 | low | **The Funnel drift check reads one authority.** `verify_serve_json` checks only the configured mapping (`config.rs:251-298`); a second Serve mapping or TCP forward on a Funnel port to the bridge goes unnoticed. Auth still holds. | 1 | confirmed. **Fixed, not live-verified.** |
| 60 | B13 | low | **Phone "desktop images" follow links** in Downloads/Desktop/Pictures (`desktop_images.rs:186-214`) and the phone can read the copy back (`host.rs:5764-5788`): any picture-named target ≤ the inbox cap. | — (paired phone) | confirmed. **Fixed, not live-verified.** |
| 61 | C6 | low | **Repo config can name a FIFO the pre-check misses.** `git_bounded::hazard` stats fixed names only (`git_bounded.rs:14-20`); `core.excludesFile`, `core.attributesFile`, `mailmap.file`, `blame.ignoreRevsFile` are not checked. Bounded at 2 min per call. **Fixed, not live-verified.** | 0 (open the folder) | confirmed |
| 62 | C5 | low | **The HTML/CSS/SVG preview has no CSP of its own** (`format.ts:150-165`); blocking remote beacons relies on WebKit carrying the app CSP into `about:srcdoc`. | 2 | plausible-holds. **Fixed, not live-verified** (own CSP `<meta>` in the preview; desktop CSP gains `object-src 'none'; base-uri 'none'; form-action 'none'` — needs a rebuild). |
| 63 | C8 | low | **Document and reader fetches honour `HTTP(S)_PROXY`** (`browser_engine.rs:1032-1036`): with a proxy the DNS pin and own-address check do not bind a markdown-chosen image URL. **Fixed, not live-verified.** | 2 (Load images) | confirmed |
| 64 | B7 | low | **`sync_diff` runs bare `git diff --no-index`** in the app's cwd without `--no-ext-diff --no-textconv` (`commands/sync.rs:2014-2018`; allowlisted in `BARE_GIT_ALLOWED`, `commands/git.rs:5820`). | 2 | plausible. **Fixed, not live-verified.** |

Informational, no gap row (hardening, steps 25–26): wall-clock expiry of phone
sessions, challenges and tickets (B8); inotify watches shared user-wide (B9);
host-tab tmux targets matched by prefix, no `=` (B12); OSC 52 payloads keep
C0 characters other than CR/LF; the server `.deb` is verified against a key
fetched from the same repo (publish its fingerprint elsewhere); `fresh-vm.sh`
checks `SHA256SUMS` but not its signature.

### Re-checked and holding (not new gaps)

Remote-host tab lane (`21eadf64..ff9f83ab`): no-dial argv, literal socket,
validated session names, nothing raw on the API, `tab_on_host` refusals, HPC
rules — sound (B; residuals are gaps 44 and B12). Phone teleport's `worktree
add` is hookless. Tabby's web lane (public addresses only, DNS-pinned, no
proxy) and the Mobile host's `/mcp/web`. Codex hook trust (hash-bound).
`agent_global` merge. Approval cards bound to digests/SHAs. OSC 8 and OSC 52
after xterm 6. The login-PTY paste is bound to the exact spawn. Popout/present
URLs. `src-tauri/patches` match upstream 2.12.1 but for the documented patch.
Dependency pinning. Crash log stays local. PDF viewer links. Processes left
detached in a fence die with its pid namespace (but see gap 43 for the pane's
trailing shell).

### Last run's open follow-ups

Still open: pin allowed roots (now step 16, covering desktop roots, fence
roots and the phone's `files::canonical_root`; the server already has
`through_planted_link`); gap 19 `repo_changed` race (pass the spawn-time
`GIT_DIR`); `local_model_of` trusting the env pair; `prepare` at quit / tab
closed during `prepare`; gap 30's `--ro-bind-fd`; launcher extensions (step
25); UI for `git_ci_repos`, CalDAV rows waiting to push, refused navigations;
CalDAV in-flight guard per collection. Fixed since: `workspace_sync` now
sanitizes stored tabs; the headless relaunch strips persisted env (its
`TAB_UID` half not re-checked). The bundle-import / gap 33 marker question
narrowed: moot unless `project_transfer` writes into a local-model home (not
traced).

## Rules for every step

As the 2026-10-08 run: other sessions edit the same tree — edit around their
hunks, never revert, stash, checkout or commit unasked. Never start the app.
Backend edits finish with `npm run backend:stale`, reported. Every fixed gap:
mark its row "**Fixed, not live-verified.**" New UI gets an `UntestedTag`
and a register row; strings go through `useT()`. Steps waiting on a decision
below wait for it. Reuse the existing safe-read primitives — one rule
everywhere (no-follow, non-blocking, regular file checked on the opened
handle, size cap): `home_io::open_regular`/`HomeDir`, `git_bounded`'s small
regular reader, `files::ProjectDir`. No new third copy.

## Steps

Ordered by value; the three reviewers' rankings agree on the top five.

| Step | Gaps | Files | Fix | Decision |
|---|---|---|---|---|
| 1 | 42 | `services/agent_auth.rs` (+ `opencode_store.rs` read) | A per-CLI admissibility check at **adopt and place**, inside `reconcile_home_in` (so the sidecar's headless launches get it). OpenCode: a JSON object of `api`/`oauth` entries only, no unknown fields, no `wellknown`; adopt from a home only token rotation of an existing `oauth` entry — never a new entry, changed key, type, `enterpriseUrl` or `accountId`; show a refusal in the Agents view. Startup sweep (window and sidecar) renames failing copies aside (`.pre-scope` pattern) and flags a V2 database holding `wellknown` sources, offering a per-scope sign-out. Then survey Goose `secrets.yaml` and Qoder `.auth` the same way. | D1 |
| 2 | 45 | `services/mobile_control/web_client.rs`, `src-tauri/build.rs` | **Now:** `serve_bundle` opens no-follow, regular file on the handle, size cap; in dev builds no pre-auth `assets/` from disk. **Then:** drop the `SOURCE_ROOT/web-dist` candidate and embed the bundle in dev builds only (one `include_bytes!` per file, not `build.rs`'s byte-literal helper — ~17 MB, optionally pre-gzipped), inline-script hashes computed at build time. Keep `WEB_DIST` for the server `.deb`. | D2 |
| 3 | 46 | `services/remote_sync.rs`, `services/sync_auto.rs`, `commands/sync.rs` | Read every mirror file to push through one held-handle helper (no link on the way, `O_NOFOLLOW\|O_NONBLOCK`, `fstat` regular, 64 MiB cap from the handle, read in `spawn_blocking`); lstat for divergence. Report skipped links, special files and over-size files as a per-project notice. Tests: leaf link, linked folder, FIFO, swap between walk and read. | — |
| 4 | 43 | `services/tmux_local.rs`, `mobile_control/discovery.rs`, `pty_bridge.rs` | A fenced agent's pane ends with `remain-on-exit` (visible, reattachable, no input); the desktop offers Restart / Open a shell here as explicit actions; unfenced command tabs keep the trailing shell. (Alternative: keep the shell but mark the pane so the catalog lists it as a shell and the bridge stops input.) Test: a phone on an exited agent tab cannot type into a shell with `shell_tabs` off. | D3 |
| 5 | 44 | `pty_bridge.rs`, `tmux_local.rs`, `ssh_exec.rs`, `docs/context/root_console.md` | Drop mouse-report sequences (X10, SGR, urxvt) from phone input frames with a small stateful filter; optionally a Tabtivity-owned session `key-table` binding only wheel/drag; `=<name>` targets where the host's tmux supports it (B12); correct the root_console claim. After step 4. | — |
| 6 | 47 | `commands/fs.rs` (`copy_recursive` + 3 callers) | Keep the top-level source as resolved (the user's pick); below it `symlink_metadata`, recreate links as links on Unix (skip on Windows), skip FIFOs/sockets/devices, copy regular files from an `O_NOFOLLOW\|O_NONBLOCK` handle, bound bytes and entries, report skips. Tests incl. a loop and a device link. | D4 (small) |
| 7 | 49 | new opener in `home_io` (or `services/agent_sqlite.rs`); `opencode_store.rs`, `codex_store.rs`, `token_stats.rs`, `google_chat.rs`; callers `opencode_session.rs:320-336`, `agent_session.rs:206-227` | One opener for agent-written DBs: `HomeDir` walk, regular-file check on a non-blocking handle, `SQLITE_OPEN_NOFOLLOW`, `trusted_schema` off, `DEFENSIVE`, length limit, progress deadline (as `google_chat`/`agent_history::open_untrusted`). Spawn-time checks in `spawn_blocking` under a short timeout (timeout = no session). Tests: FIFO, link, view-based schema. | — |
| 8 | 48 | `services/api_proxy.rs`, `api_meter.rs`, `api_prices.rs` | Refuse `background: true` and unparsable bodies on metered OpenAI requests; refuse or price `service_tier` priority; charge per-call server-tool fees from output items and reserve their worst case; drop or pin `OpenAI-Organization`/`OpenAI-Project` to values saved with the key. | D5 |
| 9 | 52 | `services/ide_detect.rs` | Bounded regular-file reads for `*.iml` and `.idea/.name` (no-follow, non-blocking, 64 KiB), at most ~32 `.iml` files. Tests: device link, FIFO, oversize. | — |
| 10 | 50 | new `services::loopback_owner` (from `sign_in.rs:90-137`); `commands/ollama.rs`, `mail_ai.rs`, `root_mcp.rs`/`root_mcp_mail.rs` local checks, completion; `api_proxy.rs:817-860`; `sign_in.rs` | One listener-owner helper over `/proc/net/tcp{,6}`. Ollama: accept only the owners of D6, and refuse an own-uid listener in another pid namespace (a fence) unless it is the Ollama Tabtivity started; applies to every "local only" gate, not only mail AI. Proxy: at start, if the remembered port is held by a fenced or foreign process, tell the user and end/mark the tmux-held keyed agents naming it; never fall back silently. Sign-in callbacks: own-uid filter on every Linux build. macOS/Windows: document. | D6, D7 |
| 11 | 51 | `src/lib/viewers/pdfLoad.ts`; `docs/threat_model.md`; `docs/browser_plan_b.md` | Document the unsandboxed Linux renderer. Pass `disableFontFace: true` on the desktop loader (pdf.js draws glyphs; WebKit never parses embedded fonts). Track the `webkitgtk-6.0` sandboxed route as the real fix. Optionally re-encode remote markdown images in Rust. | D8 |
| 12 | 53 | `commands/synctex.rs` | Filter inputs lexically under the root before `absolutise`; never canonicalize a network path (`\\`, `//`, verbatim UNC); refuse a network `root`. Windows-only tests like gap 38's. | — |
| 13 | 54 | `services/opencode_session.rs`, `services/agent_home.rs` | Merge `{"disabled": true}` into `.config/opencode/service.json` in every Tabtivity-owned home (Host included), via `HomeFile`, so typed `opencode` uses a private server too. After step 7. | — |
| 14 | 57 | `mobile_control/discovery.rs`, settings schema, Mobile settings UI | Per-phone list for the assistant scope (`absent` = every phone, empty = none), like projects and boxes. After step 4's discovery change. | D9 |
| 15 | 58 | `mobile-web/src/App.tsx`, `thumbs.ts`, `drafts.ts`, `terminal/heldPrompts.ts`, `markup/store.ts`, `authStore.ts` | One `forgetDeviceData()` on a definite `unpaired` (not offline); drop a project's covers when it leaves the phone's list. | D10 |
| 16 | follow-up | `commands/fs.rs` (`compute_allowed_roots`), `services/agent_fence.rs` (`compute_fence_roots`), `mobile_control/files.rs` (`canonical_root`) | Apply `through_planted_link` everywhere: **drop** a registered root reached through a link planted inside another root (do not rewrite it to its real path — bwrap binds roots at their own path). | D11 |
| 17 | 55 | `services/agent_chats.rs`, `agent_session.rs` (`claude_chat_log`, `claude_session_log`) | Open `.claude/projects/<slug>` through `HomeDir` (no-follow from the home) or require its canonical path under the home's. Same implementer as step 7's `google_chat` hunk. | — |
| 18 | 59 | `mobile_control/config.rs` | Walk every `Web[*].Handlers[*].Proxy` and `TCP[*].TCPForward`; refuse any Funnel-enabled mapping to the bridge or its +1 port. | — |
| 19 | 60 | `services/desktop_images.rs`, inbox copy | List with `symlink_metadata`, skip links; copy from an `O_NOFOLLOW\|O_NONBLOCK` regular handle; optionally check image magic. | — |
| 20 | 61 | `services/git_bounded.rs` | Read the repo-local and common-dir config through the sanitizer's parse and stat the four path-valued keys with the FIFO/socket/device rule. User's global values left alone. | — |
| 21 | 56 | `launch_prep.rs:484`, `sandbox.rs:1739`, `agent_relocate.rs:105,233`, `git_guard.rs:79,93` | `cwd_within` refuses `..`/`.` (canonical compare for local tabs); `move_session` requires a real directory that is a live `git worktree list` entry; `guard_paths` skips a linked worktree entry and binds a pointer only `inside(dot_git)`. | — |
| 22 | 64 | `commands/sync.rs:2014`, `commands/git.rs` (`BARE_GIT_ALLOWED`) | `--no-ext-diff --no-textconv`, `current_dir` = temp dir, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_NOSYSTEM`; delete the allowlist row. After step 3 (same file). | — |
| 23 | 62, backlog #869 | `src/lib/viewers/format.ts`, then `src-tauri/tauri.conf.json` + `CspTripwire.test.ts` | First a CSP meta in the preview document (`default-src 'none'`, inline styles, `data:` images/fonts; SVG wrapped in HTML). Then bring the desktop CSP to the web client's level: `object-src 'none'; base-uri 'none'; form-action 'none'`. Order matters (the preview's `<base>` otherwise breaks). | — |
| 24 | 63 | `services/browser_engine.rs` | No proxy for `FetchOrigin::Document` (as the agent lane). On a server, also judge a client's reader/ICS hop 0 like `Document`. | D12 (small) |
| 25 | follow-up | `services/os_open.rs`, `commands/ssh.rs:259` | Add the listed launcher extensions (Windows `.ws`, `.wsc`, `.sct`, `.xll`, `.msu`, Access, `.jnlp`, `.appx`/`.msix`, `.theme(pack)`, `.search-ms`, `.iso`/`.vhd(x)`; macOS `.webloc`/`.inetloc`/`.afploc`; Linux `.jnlp`, `.flatpakref`, `.deb`/`.rpm`). `open_external_url`: parse with `url::Url`, any-case `http(s)` with a host, no userinfo or control characters. | — |
| 26 | hardening | `agent_fence.rs` (seccomp), `mobile_control/auth.rs`, `TerminalView.tsx`/`terminalControl.ts` | `ioctl` `TIOCSTI`/`TIOCLINUX` → `EPERM` in the fence's seccomp (after step 16, same file); in-memory phone session/challenge/ticket deadlines on `Instant`; strip all C0 but tab from OSC 52 payloads. | — |
| 27 | docs | `docs/threat_model.md`, `docs/guide/server.md`, `docs/context/release_signing.md` | One editor, after the code steps: mark fixed rows; rewrite stale rows (handoff "Row audit" tables: rows 4, 5, 8, 9, 17, 19, 29, the loopback-listener, API-proxy, phone-bridge, lost-phone, pair-a-phone, headless, byte-sync, auto-sync, in-app browser, incoming-mail, Linux-fence, Host-session, hooks rows; `cargo audit` ignores; extract-archive race); add rows for Tabby + web lane, phone remote-host tabs, SyncTeX, native PDF print, the browser desktop client as a third origin, and a **Server mode** section (uid boundary, `core_dispatch` confinement as defence in depth, decision `a41799cc`, shared Ollama, deferred #2353). Publish the release key's fingerprint outside the repo. | — |

Final: full gates (`AGENTS.md` → Gates), `npm run backend:stale`, every fixed
row marked.

### Parallel groups

Disjoint files; within a line run in order. Serialize the shared hot spots:
`src/lib/i18n.ts` + `i18nDicts/*` (steps 4, 10, 14, 15), `src/lib/untested.ts`,
`docs/filemap_backend.md` (new helpers in steps 7, 10), `docs/threat_model.md`
(step 27, last).

- G1 `agent_auth.rs`: 1 (its V2-database check uses step 7's opener — land that helper first or stub it)
- G2 `web_client.rs`, `build.rs`: 2
- G3 `remote_sync.rs`, `sync_auto.rs`, `commands/sync.rs`: 3 → 22
- G4 `tmux_local.rs`, `pty_bridge.rs`, `discovery.rs`, `ssh_exec.rs`: 4 → 5 → 14
- G5 `commands/fs.rs`: 6 → 16 (with `agent_fence.rs` and `files.rs`) → 26 (seccomp part)
- G6 `home_io`/new opener + stores: 7 → 13 → 17
- G7 `api_proxy.rs`, `api_meter.rs`, `api_prices.rs`: 8 → 10's proxy part
- G8 `loopback_owner`, `ollama.rs`, `mail_ai.rs`, `sign_in.rs`: 10
- G9 single files: 9 (`ide_detect.rs`), 12 (`synctex.rs`), 18 (`config.rs`), 19 (`desktop_images.rs`), 20 (`git_bounded.rs`), 24 (`browser_engine.rs`), 25 (`os_open.rs`, `ssh.rs`)
- G10 frontend: 11 (`pdfLoad.ts`), 23 (`format.ts` → `tauri.conf.json`), 15 (`mobile-web/`)
- G11 `launch_prep.rs`, `sandbox.rs`, `agent_relocate.rs`, `git_guard.rs`: 21

No step adds a Tauri command. Step 2 changes `build.rs`: a backend edit, so
`npm run backend:stale`, and a full `package-dev` pass for the dev build.

## Decisions for the user

Each with the reviewers' recommendation first.

- **D1 (step 1) — OpenCode login sharing.** (d) content check **plus** adopt
  only token rotation, never a new or changed key, entry or endpoint, with the
  V2 database sweep *(recommended by A)*; (c) content check and never place the
  file in the Host and assistant homes *(B prefers (a)+(c), since a phone can
  start Tabby chats with no window)*; (b) per-scope `auth.json` (simplest;
  under V2 the shared file mostly seeds new homes anyway); (a) content check
  only.
- **D2 (step 2) — dev browser client.** Dev-only embed in the binary
  *(recommended, feasible)*; serve a copy `package-dev.sh` makes outside the
  fence and hash-verifies; or accept under C3 *(all reviewers: no — it needs
  no commit or build)*.
- **D3 (step 4) — what a fenced agent's pane does after the agent exits.**
  (a) `remain-on-exit`, no input; explicit Restart / Open a shell
  *(recommended: race-free, also removes the TIOCSTI landing spot)*;
  (b) keep the shell, mark the pane, phone treats it as a shell tab.
  Changes desktop behaviour either way.
- **D4 (step 6) — links inside a copied folder.** Recreate as links
  *(recommended, like `cp -R`)*, or skip them.
- **D5 (step 8) — OpenAI `background` requests.** Refuse on proxied tabs
  *(recommended; Codex and OpenCode do not use them)*, or allow with a full
  reservation held until completion is proven (the proxy cannot poll).
- **D6 (step 10) — which Ollama listener owners count.** Own uid (not in a
  fence), root, system accounts below `SYS_UID_MAX`, plus an explicit uid the
  user or hosted admin names; on a server the admin's uid is required
  *(recommended)*. Own uid only breaks the usual `ollama` system-user install.
- **D7 — network isolation of the fence.** Client-side owner checks now
  (step 10), Landlock TCP-bind restriction (kernel ≥ 6.7) as tracked hardening
  *(recommended)*; `--unshare-net` with a forwarder changes too much (every MCP
  lane and the proxy).
- **D8 (step 11) — unsandboxed Linux renderer.** `disableFontFace` now and
  record the `webkitgtk-6.0` route as the real fix *(recommended)*; add Rust
  re-encoding of remote markdown images; or document only.
- **D9 (step 14) — Tabby on the phone.** Per-phone list *(recommended)*, or a
  default-off switch like root.
- **D10 (step 15) — what a revoked phone forgets.** Covers, drafts and held
  prompts always; markup layers on revoke too, since they hold the document's
  words *(recommended)*; or keep unsent markup.
- **D11 (step 16) — pin roots (last run's follow-up 1).** Yes, one rule in
  three places, dropping a root reached through a planted link
  *(recommended)*.
- **D12 (step 24) — document images behind a proxy.** Drop the proxy for
  document fetches *(recommended; proxy-only machines and servers lose remote
  markdown images — say so in the server guide)*, or keep it and accept the
  pin bypass.

## Implementation notes / deviations

Steps 1–26 were built on 2026-10-24 by separate implementers; none ran live, and
`npm run backend:stale` is the user's to act on. Step 27 rewrote
`docs/threat_model.md` (rows 42–64 marked, stale rows rewritten, new rows for Tabby
and its web lane, remote-host tabs on the phone, SyncTeX, native PDF print, the
browser desktop client, and a Server mode section) and added the key-fingerprint
to-do to `docs/context/release_signing.md` and `docs/guide/server.md` — nothing is
published; that is the user's to do. Deviations the implementers reported:

- **G1 (gap 42):** a first OpenCode login made inside a tab is not adopted (use import
  from this computer); a scope's sign-out moves its whole OpenCode database aside;
  Goose `secrets.yaml` was surveyed as credential-only, Qoder's format is unknown and
  its `.auth` stays unchecked.
- **G2 (gap 45):** the inline-script hashes are computed at run time, not at build
  time; no gzip; a release build serves `WEB_DIST`.
- **G3 (gap 46):** backslash file names are refused on a Unix push; the skip notice is
  in memory.
- **G4 (gaps 43, 44):** the tmux `key-table` binding was not done (the bridge filters
  mouse reports instead); the dead-pane card is not in popouts.
- **G5 (gap 47):** skips from `import_external_file` (drop, Downloads, clipboard) are
  only logged.
- **G6 (gaps 49, 55):** SQLite still opens by path after the check (a residual race);
  step 17's returned paths are reopened by path.
- **G7 (gap 48):** a priced `service_tier` is refused rather than priced; the image fee
  is assumed at $0.60; the hosted shell tool is not priced.
- **G8 (gap 50):** a foreign-held proxy port ends the tmux sessions that name it; there
  is no UI for the named Ollama uid; macOS and Windows keep the address-only trust.
- **G9a (gap 53):** mapped Windows drive letters are not covered.
- **G10 (gap 58):** the Files favorites and recents are not forgotten on unpair; the
  anchor rewrite was not checked in a real WebKit.

Still open, in no step: the gap 19 `repo_changed` race (spawn-time `GIT_DIR`),
`local_model_of` trusting the env pair, `prepare` at quit, gap 30's `--ro-bind-fd`, a
UI for `git_ci_repos`, for CalDAV rows waiting to push and for refused navigations, the
CalDAV in-flight guard. Tracked elsewhere: Landlock TCP-bind
(`todo/group-o-security.md`), the sandboxed `webkitgtk-6.0` route
(`docs/browser_plan_b.md`), publishing the release key's fingerprint outside the repo,
and `scripts/fresh-vm.sh` not verifying the `SHA256SUMS` signature.

## Not reviewed

- macOS Seatbelt and Windows at runtime (diffs read only); containers
  (`services::sandbox` mounts, processes outliving a tab, shared pid
  namespace within a project container); VM projects and the `mail_reader`
  lane.
- `core_dispatch` `USER_CONFINED` rows one by one; hub, calendar, keeper,
  broker, OIDC internals; vault rotation (unchanged since `eacfa41a` but RNG).
- `markup.rs`/`markup_pdf.rs` parsers; `files_windows.rs`; PGP/S-MIME, the
  IMAP loop, mail filters, the review panel; `highlight.ts` and compare/merge
  (unchanged); `TableView` beyond the read cap.
- Help and schedule MCP internals; `agent_turn`; `api_proxy` streaming
  internals beyond the OpenAI parity check; `agent_global`'s one-time import;
  Codex's honouring of `features.shell_tool=false` across releases; the AI
  switch (not a containment boundary).
- Goose `secrets.yaml` and Qoder `.auth` formats (step 1 asks for the
  survey); `git_peer` beyond "Local wins" and a destructive-step spot check;
  `local_loss` completeness; the `TAB_UID` half of the headless follow-up.
- Live behaviour of everything above: nothing was built or run.
