# Whole-project screen — 2026-10-15

Five parallel read-only auditors, one per slice (backend commands/core, backend
services + server crates, frontend stores/lib, frontend components + CSS,
phone PWA + scripts/CI/repo hygiene), run against develop `dd5ede60`.
Nothing was built, run or edited. The four top security items were re-read
against the source by the coordinating session and hold. Line numbers are as
of that commit; verify before fixing.

## Verdict

Critical: 0. High: 12. The codebase is well hardened where it tries to be
(fence, phone API, gateway auth, git hardening, i18n in components, no `any`).
The problems are (a) a few security claims in doc comments that the code
underneath no longer meets, (b) fail-open edges inside fail-closed gates,
(c) stores/lib building English UI text outside i18n, (d) four forbidden
blurred-box-shadow animations, and (e) rename residue and generated-artefact
drift in the repo.

## High — fix first

Security / invariants
1. `src-tauri/src/commands/credentials.rs:104-118, 212-233` — keychain paste gate is caller-driven: `note_pty_input` marks a PTY as a login terminal when any ≥8-byte write *contains* a minted login string, and `remote_login_command` hands that string to the caller. A compromised renderer or browser client can `cat > file`, echo the string, then `credential_paste_to_pty` → saved SSH/VPN password written to a file.
2. `src-tauri/src/commands/projects.rs:2778` — `save_project(local_file, project)` writes caller-supplied JSON (`Project` has `#[serde(flatten)] extra`) to any absolute path. Registered, class `Core`, **zero callers** anywhere. Delete it.
3. `src-tauri/src/services/exec_trust.rs:75-82, 315-327` — hook fingerprint fails open: an unreadable hooks dir (`unwrap_or_default`) or unreadable executable hook (`read().ok()?`) contributes nothing, so a fenced agent can `chmod 0311 .githooks` / drop an unreadable-but-executable hook and the user's next Commit click runs it on the host unapproved. Make read failures a subject, like the existing `unread` closure.
4. `.githooks/pre-push:215-220` — version-bump commit uses bare `git commit`, which commits the **whole index**, not the four `git add`-ed files; the re-push runs with `TABTIVITY_BUMPING=1` which skips the privacy scan. Anything staged rides to the public remote unscanned. Use `git commit --only -- <files>` or a private `GIT_INDEX_FILE`.
5. `screenshots/eldrun-current.png` — tracked, published by `pages.yml` to the Pages site; shows real `user@hostname`, home path, a `claude.ai/code/session_…` URL and other private project names. Blob not in `scripts/privacy-reviewed-binaries.txt`. Replace and consider history.
6. `src-tauri/src/commands/git_publish.rs:198-204, 531-535, 753-761`; `commands/git.rs:1015-1017` — five local git spawns (`remote get-url/remove/rename`, `rev-parse --show-toplevel`) bypass `hardened_git_command_in` (no HARDENED_CONFIG, no `pin_common_dir`), contradicting git.rs:568 "the one function every LOCAL git spawn goes through". The `.git/commondir` vector does not care which verb runs.
7. `src-tauri/src/schema/agent_tasks.rs:22-106` — every persisted struct in `agent_tasks.json` has `deny_unknown_fields`; one new optional field makes every older build (packaged/frozen/dev share the state dir) fail all schedule commands. Violates the round-trip invariant; `schema/agent_prompts.rs:1-12` documents why.

Correctness
8. `src/lib/transport/wsClient.ts:109-113, 202-211` — `close()` nulls `this.socket` before `onclose` fires; the handler early-returns, so in-flight `invoke`s and `whenReady()` waiters never settle (browser client).
9. `src-tauri/src/services/openvpn.rs:1510-1512` — connect timeout does `child.kill(); child.wait()` on a root `pkexec openvpn`; kill fails EPERM, wait blocks forever, the blocking worker hangs and a root OpenVPN keeps running unregistered. Use `kill_pidfile` as `disconnect` does.
10. `src-tauri/src/services/git_peer.rs:1104-1117` — ssh exit 255 (link dropped) is classified as "remote is a clean empty side", not `probe_error`; a flap between probe and `init_pairing` can `reset --hard` a real remote repo. Opposite of the rule at :2489.
11. `src/stores/projects.ts:94-107, 122-127` — `pendingRemotePassword` / `pendingViaLogin`: plaintext SSH passwords stored in a module Map, filled by ProjectDialog and HpcPipelineWizard, **never read, never deleted** (reader was removed). Delete the map and the two writers.

Performance (AGENTS.md invariant)
12. Four animated blurred `box-shadow`s on WebKitGTK: `src/styles/onboarding.css:296-306` (`hint-bubble-breathe`, infinite on every onboarding hint), `src/styles/projects-tabs.css:132-141` (`drag-group-absorb`, infinite during Alt-drag), `projects-tabs.css:2203-2218` (`tab-land`), `src/styles/subwindows.css:438` (`.blob-node` transition). Opacity-only variants already exist for reduced-motion.

## Medium — worth a batch each

i18n in non-component code (components are clean; stores/lib are not)
- VPN-up toast hard-coded English twice (`stores/projects.ts:75-77`, `lib/remote/vpn/vpnAutoConnect.ts:242`) while key `vpnAutoConnect.upToast` exists and is used at :166.
- `lib/remote/remoteConnect.ts:111` "authenticate in root terminal" toast; `stores/projects.ts:1520` "Could not stop every persistent session" dialog; `:1311` `local/remote` labels; `lib/transport/wsInternals.ts:272-279` Ok/Cancel/Yes/No; `lib/transport/clientAdapters.ts:18,42,45`; `lib/calendar/calendarTime.ts:445` AM/PM; `:456` default locale "en"; `mobile-web/public/sw.js:124-127` push fallback titles; `components/header/AppResourceDisplay.tsx:121-190`.
- Dictionaries: `steering.popout.desc`, `shortcutHelp.steeringIntro` drop `{app}` in all four languages; the i18n test compares placeholders after `fillBrand` so it cannot see this.

Dialog scheme (PromptDialogs, #244) — 14 leftover `window.confirm`/`prompt`/`alert`: MobileIndicator:217, SkillsLibraryView:207/240/262, DeckView:734, ImageAnnotator:193, MailPane:353, MobileSettings:383/432/768, MobileSetupGuide:51, TodoBoard:370/387, TodoCardDialog:155, RemoteMachinesWindow:626, ProjectPill:2298/2300.

Hooks / state
- `components/layout/DetachedCenterPanel.tsx:328-333` — `listen()` without disposed guard, deps `[scope, tabs]` → leaks a listener per tabs-store write that races the promise.
- `stores/tabs.ts`: `persistScope` :5359 swallows every layout-save failure silently (read-only state dir → stale layout next launch, nothing shown); `closeHiddenGroup` :4147 and `applyDetachedEdit(close)` :4575 skip the `forgetPty`/`purgeForTab` teardown the other close paths do; `retargetTabs` :3173 and `setTabTmuxName` :3455 bypass `writeScope`; `attachGroup` :4003 reads `entries` before `set()` (race); `saveLayout` doc says "no production caller" but `AppShell.tsx:836` calls it on quit; `deserializeTree` :2589 dereferences `children/sizes/tabKeys` on an unvalidated on-disk tree.
- `stores/projects.ts:1949-1971` — disconnected remote project returns before `setSidePanelFolder`; side-panel folder never restored.
- `wsClient.ts:234` `frame.capabilities!` — a hello without capabilities kills boot with a TypeError.
- 8-module import cycle: projects ↔ rootOverlay ↔ remoteConnect ↔ boxes ↔ hostBusy ↔ globalMachines ↔ machineSync ↔ hpcHost (only one edge documented).
- `MobileSettings.tsx:751`, `useModelsHub.ts:399` — `void invoke(...)` with no `.catch` (siblings have one).
- `ProjectPill.tsx:2283-2295` — in-folder tab layout (attacker-controlled) cast with `as never` ×4 into `loadFromLayout`; the Rust sanitiser is the only guard.

Backend correctness
- `services/remote_sync.rs:803-814` — SFTP pull stages via NamedTempFile (0600) and never restores mode; `0755` scripts become non-executable; rsync path preserves modes.
- `services/worker_sync.rs:150-157, 273-290` — "Refusing to create empty bundle" treated as "worker has HEAD" also when mirror HEAD moved *backwards*; record advances, worker never moves back.
- `services/mail_engine.rs:79-89` — `with_platform_verifier().expect()` inside OnceLock: broken CA store panics every IMAP/SMTP connect.
- `commands/git.rs:521-524` — `Command::new("/bin/sh")` refusal path ungated on Windows (os error 2 instead of the explanation).
- `storage.rs:319-331` — `FileLock::exclusive` ignores `flock` failure, `shared()` propagates it; `patch_json` cross-process safety silently lost on FUSE/network mounts.
- `terminal/mod.rs:1313-1319` — graceful reap SIGKILLs the snapshot pid list after 2 s without re-checking parentage (pid-recycle risk; `GracefulBlocking` shows the safe shape).
- `commands/sync.rs:820,1131,1554,1809` — `let _ = save_manifest(...)`: failed manifest save → stale base → next status shows false conflict; a forced push can overwrite the host.
- `services/core_dispatch.rs:186` — `USER_CONFINED_PATH` confines only `list_dir_all`; `list_dirs`, `import_external_file`, `remote_download_to`, `remote_upload_file`, `calendar_read_ics/write_ics` take unconfined paths for a `Role::User` browser client, contradicting the comment.
- 20 registered Tauri commands with no caller outside the generated class table (`check_pid_alive`, `copilot_project_policy`, `copilot_stop`, `hpc_ws_release`, `list_installable_models`, `list_ollama_models`, `local_tmux_list`, `mobile_prepare_phone_install_script`, `ollama_is_running`, `ollama_registry_size`, `remote_connected_ids`, `restore_open_apps`, `save_project`, `set_box_relations`, `spell_languages`, `switch_project_windows` (deprecated, still dispatched), `vm_blocked`, `vm_unpushed_commits`, `workspace_name`, `workspace_switch`). Dead IPC surface.

Repo / CI / deps
- `src-tauri/Cargo.toml:91,98,338` — `chrono-tz`, `idna`, `ipnet` declared but unused in src-tauri (moved to src-core).
- `ci-cd.yml:316-319, 381-384` — Windows/macOS clippy permanently `continue-on-error`; `:157` daemon clippy lacks `--all-targets` that AGENTS.md and gates.sh use.
- `docs/start-tabtivity-tauri-hotreload.sh` is a stale fork of the root launcher (no log rotation) and `docs/guide/building.md:47-54` tells users to install it.
- `vite.mobile.config.ts:116-118` — build timestamp baked into the entry chunk → SW cache name changes on every `npm run build`, every paired phone reinstalls the worker after each gate run.
- `package-lock.json` root version 0.2.9 vs package.json 0.2.11; `bump-version.sh` skips the lockfile.

Bloat (structural, not duplication)
- Single functions: `FileTree()` 4,600 lines; `PdfCanvas()` 3,665; `CodeEditor` 2,770 (inside the 10,908-line FileViewerPane.tsx, whose pure helpers :1677-2715 belong in src/lib/viewers); `TerminalView` one 1,600-line `useEffect`; `MobileBridgeHost.tsx` 2,661 lines of request router with module-level mutable state living under components/ (it enforces the "raw ids never cross" invariant and is not unit-testable there); `mobile-web/src/screens/Terminal.tsx` 4,553; `stores/tabs.ts` 6,606 with seams at :1940-2420, :3855-5000, :5512-6066.
- Disk-reload mtime poll copy-pasted 7× (GifView, OdtView, FileViewerPane ×3, PdfPresentApp, PdfViewer); only one copy honours `saverInterval(…, quiesce)`. One `useDiskReloadPoll` hook.
- Three copies of the agent CLI list (`tabs.ts:6085 AGENT_CMDS`, `RESUMABLE_AGENTS`, TabBar `AGENT_ITEMS`, backend registry); a new CLI restores as "shell".
- Dead code kept alive by tests: `src/lib/agents/prompt/filter.ts` (whole module) + ~15 lib functions imported only from `__tests__`; 14 unreferenced `pub fn`s in services (list in audit_backend_services.md); ~110 TS exports with no external importer (`unused_exports.txt`); ~40 commands still on `AppHandle`/`State`/`Window` signatures; 8 bare `#[tauri::command]` in `commands/connect.rs`.
- Duplicate helpers: `formatBytes` ×2 (+`formatSize`), `escapeHtml` ×2, string-hash ×3, `sleep` ×2, private `basename`.

Untested large components: ProjectPill (113 KB), ModelsHubSections, RemoteMachinesWindow, YamlTree/YamlGrid, DetachedApp, HpcPipelineWizard, TodoBoard, MailIndicator, BrowserPane, PdfPresentApp.

## Low — see per-slice files
Rename residue (`start-eldrun-*.sh`, `eldrun-dev.cmd`, `scripts/rename-codemods/`, old-name screenshot filename; `docs/root_cleanup_plan.md` already decided deletion 2026-10-05), tracked `src-tauri/gen/schemas`, STATUS/ROADMAP dated v0.1.68, `PROJECT.md` dead link, `tsconfig.mobile.json` weaker than desktop, pre-push `gh secret list` on every push for non-admins, Docker sandbox image unpinned, CSP `blob:` note, `.gitleaksignore` records a real token in public history, `SystemMonitorPane` renders missing per-user CPU/mem as 0, `TabBar.tsx:467` `!` at module load, DeckView TeX poll restarts on every keystroke, CSS selectors split across files, portaled `.project-pill-popup` without `color`, mode-bit/atomicity nits in agent_session hook script and tmux launcher, cookie max-age literal 43200 beside `SESSION_MAX`, unbounded notify channels, zip extraction with no size bound, `state_dir_base` `/root` fallback when HOME unset.

## Systemic patterns
1. Confident doc comments ahead of code (paste gate, "one git spawn function", "user held to roots", `saveLayout` "no caller", GitHistory "never invoked").
2. Fail-closed gates with fail-open `.ok()?` / `unwrap_or_default()` / `is_err()` inside (exec_trust, git_peer probe).
3. `let _ =` on writes that feed later decisions (manifest, `.placed`, worker record, layout persist).
4. i18n discipline stops at the component boundary.
5. Two `listen()` idioms; only the guarded one is safe.
6. Dead IPC/pub surface never pruned; generated tables make naive "has caller" checks pass.
7. Gates documented in three places (AGENTS.md, gates.sh, ci-cd.yml) with drift checks between only two; "staged" exceptions never expire.
8. Derived artefacts drift from their source (lockfile version, gen/schemas, docs launcher copy, site screenshot, SW cache name).

## Not covered (union)
Line-by-line reads of the largest files (mobile_control/host.rs 11.6k, mail_store.rs, root_mcp*, agent_session hook bodies, mail.rs/ollama.rs/calendar.rs/apps.rs command bodies, mobile Terminal.tsx, calendar/todo/server/stats components); Windows/macOS FFI bodies; test bodies; docs factual accuracy; anything that needs the app running (repaint cost, render storms, selector identity). No cargo/npm/eslint/udeps/gitleaks/shellcheck run.
