# Threat-model recheck 2026-10-08 — findings and fix plan

Status: **partly done.** Plan steps 1, 2, 3, 6, 8, 13 and 14 are fixed in
develop (`bdafdf03`, 2026-10-09; not pushed, not live-verified). The rest is
listed under "Resume state" below.

## Resume state (2026-10-10)

"Continue the threat recheck" means: take the next item below whose decision
is answered, run it with the plan → implement → review routine (handoff:
`docs/threat_recheck_2026_10_08_handoff.md`, append new sections there), mark
its rows in `docs/threat_model.md`, then land on develop. Ask the user only
the decision an item names. Saying "continue" is the user's go-ahead for the
subagents that routine spawns (plan reviewer, then a fresh implementer and
reviewer per step, then a final reviewer), in a worktree under
`.claude/worktrees/`.

1. **Plan steps whose decisions were answered 2026-10-12** (see "Decisions
   for the user"); suggested order 4, 5, 7, 11, 9, 10, 12 (7 after 5):

   | Plan step | Gaps | Decision |
   |---|---|---|
   | 4 | 19 | A2: only the confirmed repo |
   | 5 | 22, 31 | D1: refuse every symlinked leaf |
   | 7 | 23 | D3: keep re-raster, own figure folder only |
   | 9 | 25, 27, 33, 34 | E3: redact + mark external; CalDAV writes always stage |
   | 10 | 26, 32 | E2b: refuse http CalDAV entirely |
   | 11 | 21, 38 | C2: confirm all, refuse launchers; D6: navigation gate |
   | 12 | 20 | B1: drop `live_pwa`; C3: keep auto-queue (document), launcher verifies a state-dir hash |

   On 2026-10-12 other sessions had uncommitted edits in `commands/fs.rs`,
   `services/git_ci.rs` and `services/agent_fence.rs` (steps 4 and 5 touch
   them): branch from a develop that contains them, or edit around them.

2. **Follow-ups that need no decision** (found during the run; details in
   the handoff's "Final review → Flagged for user"):
   - Re-survey the logins still shared to every home, the Host home
     included: Goose `secrets.yaml`, OpenCode `auth.json`, Qoder `.auth`
     (gap 16 residual).
   - Spawns still in `launch_prep::prepare` at quit escape `kill_all`, and
     closing a tab during `prepare` leaves an orphaned PTY (gap 18 notes,
     older than this run).
   - Gap 30 residual: bwrap/Seatbelt open the control paths by name after
     the check (`--ro-bind-fd` would close it).
   - Background `sync_auto` skips files over 64 MiB with only a log line.
   - `workspace_sync` serves stored tabs without the load sanitizer; a
     headless relaunch of an adopted agent tab before a window re-saves it
     has no `TAB_UID`.
   - Spreadsheet reader limits: no `RLIMIT_AS` on macOS, no Job object on
     Windows, `PR_SET_PDEATHSIG` Linux-only.
   - Reviewer B's lead (`agent_session.rs` transcripts through symlinks):
     step 4 refuses a link at the leaf only; a linked directory component is
     still followed.
3. **Never reviewed:** reviewer F's whole area and the per-reviewer gaps
   (see "Not reviewed" at the end). That needs a fresh read-only review
   run first.
4. **Never run:** the 12-step live click-through (handoff, "Final review →
   Live click-through"), and macOS/Windows compiling. Watch the first CI run
   on those platforms.

Six read-only reviewers went over HEAD `16182b63` on 2026-10-08. Each read
`docs/threat_model.md` and its area's `docs/context/` files first, then checked
the code, then proposed fixes. This file merges their findings and fix plans.
The new gaps are rows 16–41 of `docs/threat_model.md` ("Gaps found
2026-10-08").

| Reviewer | Area | Result |
|---|---|---|
| A | Agent fence, agent homes, shared logins, exec_trust, root/schedule/push/markup/help MCP transport, API proxy, local drivers | 1 high, 2 medium, 2 low |
| B | Phone sidecar + PWA, remote/SSH/VPN, worker_sync, lockstep, byte-sync, containers | 1 medium (dev builds), 1 low |
| C | Webview perimeter, IPC, project-driven host execution, secrets, CI/release | 1 high, 2 medium, 1 low |
| D | In-app file viewers and their parsers/save paths | 3 medium, 1 low-medium, 5 low |
| E | Mail/calendar/to-do MCP tools, mail and CalDAV sync | 3 medium, 4 low |
| F | Threats not yet considered | **Not delivered**: a safety classifier stopped the write-up twice. Only its "checked and handled" list survives (below). |

No earlier-fixed gap regressed. Gaps 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13,
14 and 15 were each re-checked by at least one reviewer and are present in
HEAD. All eight issues of the 2026-09-23 MCP audit are fixed in HEAD (one
leftover: step 9's audit reason).

The two high findings were spot-checked again while merging. Both hold.
For gap 17 the persisted `env` is applied after Tabtivity's own `PATH`
(`src-tauri/src/terminal/mod.rs:1458-1463`), so it can replace `PATH` as well
as set loader variables.

## Findings

Severity is the reviewer's. "You do" is the threat model's tier. Line numbers
are at `16182b63`.

| Gap | Rev. | Sev. | Finding (evidence) | You do | Confidence |
|---|---|---|---|---|---|
| 16 | A1 | high | **Shared logins carry env files and whole login folders from any scope into every home, the Host home included.** The keeper adopts a changed `auth_paths` file from any non-local-model home into `<state>/agent-auth/<cli>/` and places it in every home (`services/agent_auth.rs:306-352,744-752`; `agent_home.rs:415-426`). Content is checked for Pi only (`agent_auth.rs:218-228`). Shared files include dotenv files the CLIs load into their environment: `.vibe/.env`, `.aider/oauth-keys.env`, `.config/mini-swe-agent/.env` (`commands/agents.rs:173,190,375`), and Cline's `providers.json` (`:162`). Login folders (CodeBuddy, Kimi) are reconciled for every file name (`agent_auth.rs:368-385`). A fenced agent writes `GIT_CONFIG_*` → `core.fsmonitor=<cmd>` into `~/.vibe/.env`; the next Vibe run in any other scope runs it in that fence, or unfenced in a Host session. | run Vibe, aider, mini-swe-agent or Cline elsewhere | Tabtivity side confirmed; the CLIs loading the file is upstream behaviour, not run |
| 17 | C1 | high | **Untrusted tab layouts keep a known-command tab's `env` (and `embedExec`).** `sanitize_tab_layout` strips authority only for unknown commands; `""` (plain shell), `sh`, `bash`, `zsh` keep `env`, and the test asserts it (`services/terminal_service.rs:430-434,806-829`). `sanitize_untrusted_layout` adds nothing for `env` (`:403-411`). `pty_spawn` applies it verbatim after `PATH` (`terminal/mod.rs:1461`). Doors: `.tabtivityproj` import with session restore (`commands/project_transfer.rs:1434`) and "adopt folder layout" (`commands/projects.rs:2709`). | import a project file or adopt a cloned folder's layout, then open it | sanitizer + spawn confirmed; restore-to-spawn not traced end to end |
| 18 | A3 | medium | **Push preflight runs the project's pre-push hook unfenced when the tab's fence registration is missing.** `preflight_command` falls back to the host when `fenced_scope_of_tab` misses (`services/git_push_mcp.rs:552-565`). `pty_kill` calls `agent_fence::on_tab_gone(id)` after an await with no generation check (`commands/terminal.rs:399-414`), and an unmount's un-awaited kill can land after a remount respawned the same id (`terminal/mod.rs:1263-1278`). The hook (`core.hooksPath`, e.g. `.githooks/pre-push`) is agent-writable. The same race drops the new tab's proxy tokens and turn binding. | an ordinary pane remount, then the agent pushes | fail-open confirmed; trigger is a race |
| 19 | A2 | medium | **CI reads can target any repo the GitHub token can read.** `git_guard::guard_paths` binds only control files that exist at spawn (`services/git_guard.rs:43,87,118`), so an agent can `git init` in a repo-less project and own `.git/config`. `ci_runs`/`ci_run`/`ci_security_alerts` take the repo from `remote.<r>.url` and send the token (`services/git_ci.rs:54-72`; origin added at `commands/git_hosting.rs:199-211`). Private failed-job logs, annotations and code-scanning alerts come back, no prompt. Listed today only as a macOS residual. | keep a GitHub token; run an agent in a folder with no repo at tab start | confirmed |
| 20 | B1, C3 | medium (dev builds only) | **The dev-build loop trusts the fence-writable checkout.** (a) The sidecar serves the phone app from `<repo>/target/mobile-pwa` whenever its `.stamp` claims a newer build; no owner, mode or signature check (`scripts/package-dev.sh:42,100`; `src-tauri/build.rs:107-116`; `services/mobile_control/live_pwa.rs:91-160`; `host.rs:670,5576-5590`). A planted bundle runs as the paired phone, can type into every scope shared with it and can install a lasting `sw.js`. (b) The window runs the repo's own `scripts/package-dev-auto.sh --queue` unfenced whenever HEAD moves (`services/dev_build.rs:372-402`). (c) The launcher adopts `target/release/<bin>` trusting a `.frozen` record beside it (`docs/context/dev_builds.md:94-102`; not re-read). | run a dev build with an agent in this repo (Mobile on for a) | (a), (b) confirmed; (c) from docs |
| 21 | C2 | medium | **Double-clicking a file with no in-app viewer hands it to the OS with no prompt.** `openFileEntry` falls back to `open_file` → `opener::open` (`src/components/files/openFileEntry.ts:49-55`; `commands/apps.rs:617`). No viewer for `.desktop`, `.cmd`, `.vbs`, `.hta`, `.jar`, `.exe`, `.lnk`, `.url`, `.command` (`src/lib/viewers/fileUtils.ts:117-137,195-260`). Reader change cards with agent-reported paths reach it too (`src/components/terminal/TerminalReaderChanges.tsx:286-305`). | double-click a file in a cloned repo or a Reader card | confirmed; per-OS launch behaviour is platform knowledge |
| 22 | D1 | medium | **A dangling symlink defeats viewer write confinement.** `resolve_for_confinement` uses `exists()`, false for a dangling link, so it checks `canonical(parent)/name` (`commands/fs.rs:2048-2057`); `write_file_bytes_local` then `fs::write`s through the link (`fs.rs:1738-1752`). Reached by PDF Save (`PdfViewer.tsx:2962`), deck autosave (`DeckView.tsx:435`), "Open as deck" (`PdfViewer.tsx:1705-1714`), TeX create-file (`tex.ts:2329`), ImageAnnotator (`ImageAnnotator.tsx:314`), the deck figure poll (gap 23). Links to existing files have the same check-then-open race in the `read_*`/`write_*_local` helpers. | save in a viewer | dangling case confirmed; race plausible |
| 23 | D3 | medium | **An open deck overwrites files its JSON names, with no click.** With `deck_presenter` on, the figure poll writes a PNG to `resolveRel(dir, obj.src)` when the PDF beside `texSrc` changes (`src/components/embed/deck/DeckView.tsx:1239-1290,1277-1280`); absolute paths pass (`deckAssets.ts:26-29`; `src/lib/viewers/deck/sidecar.ts:294`). A fenced agent reaches a box-sibling project its fence cannot. | keep an agent-written deck open | confirmed |
| 24 | D2 | medium | **A tiny .xlsx aborts the app.** calamine 0.36.1 `Range::from_sparse` allocates the cells' bounding box (`calamine/src/lib.rs:958-961`); cells at A1 and XFD1048576 ask ~1.7·10¹⁰ cells and the failed allocation aborts the process (`commands/sheets.rs:71-87`). Every window and non-tmux terminal dies. | open the spreadsheet | confirmed by source read, not run |
| 25 | E1 | medium | **Ollama cloud models break "mail never leaves this machine".** `mail_ai::chat` (incl. auto-classify of every new inbox mail) and the local-model mail-read gate check only that the endpoint is loopback (`services/mail_ai.rs:141-146`; `services/root_mcp_mail.rs:1133-1146`). A loopback Ollama forwards `*-cloud` models to ollama.com; `is_remote_entry` already detects them but only phone loads use it (`commands/ollama.rs:963,991`). The single-resident auto-assign gives such a model every role (`src/components/layout/LocalModelMenu.tsx:216-235`). | use an Ollama cloud model for Mail or as the default | backend confirmed; UI path plausible |
| 26 | E2 | medium | **CalDAV credentials follow any href a response names** (the open #869 residual, and it defeats the redirect fix). The credential origin is the URL being requested (`services/caldav.rs:546-553`); principal, home-set, collection and resource hrefs come from the server (`:769-770,910-940`; `commands/caldav.rs:423-449,589-603,656,679,706`) and are never compared with `base_url`. (a) A redirect target refused the password names itself as principal and gets Basic auth next request. (b) An https server naming `http://` hrefs gets the password and calendar in cleartext on every sync. | add a CalDAV account whose server redirects off-host or is hostile | confirmed |
| 27 | E3 | medium | **Mail text reaches the cloud root agent through cards and events.** "Card from mail" copies Subject and sender (`src/lib/todoBoard.ts:1019-1042`); AI extract can auto-create events (`src/components/mail/MailAiMessageActions.tsx:119-139,175-180`). `todo_list`/`calendar_list` serve them unmarked and unredacted (`services/root_mcp.rs:1654-1672,2341-2347`), against the rule that a cloud root tab never reads mail. | make a card/event from a mail, ask a root agent about it | confirmed |
| 28 | D4 | low-medium | **A deeply nested .json/.yaml blanks the window.** The flow parser recurses without a depth cap (`src/lib/viewers/yaml.ts:1109-1203`), a `RangeError` is re-thrown (`:595`) during render (`YamlTree.tsx:100`, `YamlGrid.tsx:70`), and the app has no React error boundary (`src/bootstrap.tsx:60`). Unsaved drafts in that window are lost. | open the file | plausible (stack depth not measured) |
| 29 | A4 | low | **FIFOs in agent-writable records hang host threads.** Blocking reads of the scope's live-session slice: the single turn watcher (`services/agent_turn.rs:192`, loop `:491-560`), spawns (`:122`), resume/source/mode readers (`agent_session.rs:1472,1488,1536`); `.git/commondir` at every fenced spawn and push preflight (`git_guard.rs:100`). One FIFO stops turn state for every tab until restart. | nothing / open a tab | confirmed |
| 30 | A5 | low | **Local-model control-file setup is check-then-act in a folder other tabs of the model can write** (`services/agent_fence.rs:820-890`). A raced symlink makes the host create an empty file, or RO-mount a path, of the attacker's choice. Nothing is written. | start a local-model tab while another of that model runs | confirmed; needs a race |
| 31 | E5 | low | **Attachment "Save to project" can be redirected.** `emails_dir_in` checks `tabtivity-emails`, then `write_unique_in_dir` opens `<canonical>/<name>` by path, `O_NOFOLLOW` on the leaf only (`commands/mail.rs:4553-4577,4610-4621`). The gap-12 pattern. | save an attachment while an agent runs in that project | plausible (race) |
| 32 | E4 | low | **A failed CalDAV push loses the local edit.** `pushRow` swallows the error (`src/stores/calendar/caldav.ts:486-494`); the next sync overwrites the matched row (`commands/calendar.rs:964-971`). No dirty flag, conflict or `local_loss`. | edit a synced row offline or during a server error | confirmed |
| 33 | E6 | low | **The local-model "has read mail" taint can be lost.** `record_read_mail` ignores write errors while the read proceeds (`services/root_mcp.rs:245-251`; `root_mcp_mail.rs:1150-1153`); a new tab continuing the same Vibe conversation starts untainted (gap-7 residual: `VIBE_HOME` per model). | continue a local-model conversation in a new tab | plausible |
| 34 | E7 | low | **Filing into "Drafted by agents" ignores attachment changes.** The ✓ comparison clears `staged` (`services/mail_store.rs:2632-2641`). Send still re-binds attachments (`:2530-2538`); only the filing gate is affected. | approve an agent draft | confirmed |
| 35 | B2 | low | **The rsync fast path of a folder pull skips the 64 MiB cap and the regular-files rule.** `rsync -a -c --no-links --recursive --files-from=…` (`services/remote_sync.rs:805-830`; `commands/sync.rs:1774,1816-1850`). A hostile remote account fills the disk or drops FIFOs and unlisted files, inside the mirror only. | press Pull on a remote folder | plausible (rsync semantics) |
| 36 | C4 | low | **TeX hover preview now follows the document to LuaTeX** (8bd776ee; `commands/tex.rs:322,1176,1858`). On TeX Live 2025 writes, `popen`, remove/rename and mkdir are refused, but reads are open (`openin_any=a`), and an unpatched TeX Live < 2023 (CVE-2023-32700) runs commands. Build does not set `openout_any=p` (only previews do); LuaTeX's `io.open` on Build was not checked. | hover a formula in a hostile `.tex` | engine selection confirmed; impact depends on system TeX |
| 37 | D5 | low | **SQLite views run the file's SQL without bound**: no progress handler, timeout or length limit (`commands/sqlite.rs:57,113-128`). A recursive view spins a thread forever; huge strings exhaust memory. | open the database | plausible |
| 38 | D6 | low (Linux) / medium (Windows) | **Links in three markdown hosts navigate the main window.** `NotebookView.tsx:73-77`, `SkillsLibraryView.tsx:516-519`, `MarkdownPromptField.tsx:190-195` have no click guard (`DevTodoView.tsx:77` does), and the main window has no navigation gate. Linux: a click reloads the app and loses drafts. Windows: `safeHref` passes `\\evil.example/x` (`markdown.ts:23`), which can put an attacker page in the app window (no IPC). | click a link in a notebook cell, skill or prompt preview | handler/gate absence confirmed; Windows URL resolution plausible |
| 39 | D7 | low | **`sqlite_tables`/`sqlite_page`/`read_spreadsheet` take any absolute path** (`commands/sqlite.rs:76,87`; `sheets.rs:65`), unlike every `fs.rs` reader. Reachable only by script already in the app. | — | confirmed |
| 40 | D8 | low | **Image alt text: stale marker regex.** `attrText` splits on old space-padded markers (`markdown.ts:174` vs NUL markers `:164-165`), so restored math/code HTML lands in `alt="…"` (`:318`). No injection found; breaks the escape-first invariant. | open the markdown | confirmed |
| 41 | D9 | low | **GIF canvas allocated before the size cap** (`src/lib/viewers/gif.ts:309-311` vs `:362`): a 30-byte GIF claims 1 GB in the renderer. | open the GIF | confirmed |

Minor, folded into steps below:
- Root-lane MCP tool refusals are audited with `reason: None` (`commands/root_mcp.rs:354-355`).
- `src-tauri/src/services/sandbox.rs:49` says shared login folders are mounted into containers; the mount list (`:873-893`) does not mount them. The comment is wrong.
- The scope-less phone upload route `/api/v1/inbox` (`mobile_control/host.rs:4284`, 1 GiB cap, state dir) is not in the threat model.
- Still open from #869, reconfirmed: ODT `unzipSync` has no size cap (`OdtView.tsx:45`), pdf.js `isEvalSupported` at its default (`pdfLoad.ts:48`), `script-src blob:` in the CSP.

## Rules for every step

Same as the 2026-10-04 run (`docs/threat_recheck_fixes_plan.md`). Other
sessions edit the same tree: edit around their hunks, never revert, stash,
checkout or commit. Never start the app. Backend edits finish with
`npm run backend:stale`, reported. Every fixed gap: mark its row in
`docs/threat_model.md` "**Fixed, not live-verified.**" and adjust rows that
cite it. New UI gets an `UntestedTag` and a register row; new strings go
through `useT()`. Steps that need a decision below wait for it.

## Steps

Grouped into implementer-sized steps by area. Steps 1–4 are the high and
cross-fence items; do them first.

| Step | Gaps | Area | Fix |
|---|---|---|---|
| 1 | 16 | `commands/agents.rs` (`auth_paths`), `services/agent_auth.rs` | Take every file a CLI loads as environment or configuration out of the shared set: `.vibe/.env`, `.aider/oauth-keys.env`, `.config/mini-swe-agent/.env` and Cline's `providers.json` become per-scope, like Continue's and Crush's mixed files (or keep sharing behind a per-CLI content check, decision A1). In `reconcile_dir`, adopt and place only an allowlist of file names per login folder. The Host home never receives a shared file that has not passed the check. Keep the Pi check, the account guard and the receive-only local-model homes. |
| 2 | 17 | `services/terminal_service.rs` (`sanitize_untrusted_layout` + tests), `terminal/mod.rs:1461`, `services/launch_prep.rs` | For the two untrusted doors only, drop `env` and `embedExec` from every tab (Tabtivity rebuilds `TAB_UID` itself, `src/stores/tabs.ts:5470-5473`); state-dir layouts keep today's behaviour. Flip the `known_commands_keep_every_field…` expectation for the untrusted path and add a known-`cmd`-with-env test. Defence in depth at spawn: refuse `PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `ZDOTDIR` and similar in `opts.env` unless Tabtivity inserted them. |
| 3 | 18 | `services/git_push_mcp.rs` (`preflight_command`), `services/root_mcp.rs` (Pusher `Identity`, `grant_lanes`), `commands/terminal.rs` (`pty_kill`, `pty_kill_scope`), `services/agent_fence.rs` (`register_tab`, `on_tab_gone`) | Record the fence scope in the Pusher identity when the token is minted and build the one-shot fence from it; never fall back to the host because a registry lookup missed (fail closed). Make `on_tab_gone` generation-aware: `register_tab` stores a spawn sequence, `pty_kill` passes the sequence of the PTY it took, and only that registration, its proxy tokens and its turn binding are removed. |
| 4 | 19 | `services/git_ci.rs` (`repo_of`), `services/git_push_mcp.rs` (`ProjectPolicy`), `services/git_guard.rs` | Read CI only when `remote.<r>.url` equals the user-confirmed push URL, or a CI repo confirmed once on a card (decision A2); otherwise answer a new `ci_repo_unconfirmed` category. Defence in depth: record at spawn which roots had no `.git`, and have push and CI refuse a git dir that appeared later. Keep `not_github`, the budget and token-origin scoping. |
| 5 | 22, 31 | `commands/fs.rs` (`resolve_for_confinement`, `read_*_local`, `write_*_local`, `file_mtime_local`), `commands/mail.rs` (`emails_dir_in`, `write_unique_in_dir`), `services::files::ProjectDir` | One handle-based path for viewer and attachment I/O: `symlink_metadata` instead of `exists()` (a dangling leaf link is refused); writes open the confined parent `O_DIRECTORY\|O_NOFOLLOW` and the leaf `openat(…\|O_NOFOLLOW)`; reads `O_NOFOLLOW` or check the opened fd's real path. Attachment saves walk the project root and `tabtivity-emails` through held handles with `O_CREAT\|O_EXCL\|O_NOFOLLOW`. Reuse `files::ProjectDir` / `git_guard` helpers, no third copy. Windows: refuse reparse-point leaves. In-root symlink handling per decision D1. |
| 6 | 29, 30 | `services/agent_session.rs`, `services/agent_turn.rs`, `services/git_guard.rs`, `services/agent_fence.rs` (`local_model_control_paths`), `services::home_io` | One reader for agent-writable records: `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK`, `fstat` regular file, a few KiB cap. Use it for `.turn`, `.src`, `.mode`, `.prev`, the id record, `commondir` and the `.git` pointer; take the watcher's per-event read off the shared thread or use the same helper. Do the local-model control setup through `home_io::HomeDir`/`HomeFile` (`unlinkat`, `mkdirat`, `O_CREAT\|O_NOFOLLOW`) and bind-mount only after `fstat` on the opened handle. |
| 7 | 23 | `src/components/embed/deck/DeckView.tsx` (figure poll), `deckAssets.ts` (`resolveRel`), `src/lib/viewers/deck/sidecar.ts` | The poll auto-writes only a PNG under the deck's own figure folder (`texFigureDir`) ending in `.png`. Refuse absolute and `..` paths for deck-written `src`/`texSrc`; resolve relative to the deck's folder. Anything else needs a "Recompile" click (decision D3). After step 5. |
| 8 | 24, 28, 37, 39, 40, 41 | `commands/sheets.rs`, `src/lib/viewers/yaml.ts`, `src/components/embed/FileViewerPane.tsx`, `commands/sqlite.rs`, `SqliteView.tsx`, `TableView.tsx`, `src/lib/viewers/markdown.ts` (`attrText`), `src/lib/viewers/gif.ts` (`openGif`), `OdtView.tsx` | Parser bounds. Spreadsheets: build rows from calamine's cell reader and refuse a sheet whose bounds pass a cell cap (xls: check `DIMENSIONS`). YAML/JSON: nesting cap (e.g. 512) that throws `Bail` with an i18n reason; one shared `ViewerErrorBoundary` around each viewer pane with "Show source". SQLite: `progress_handler` deadline, `SQLITE_LIMIT_LENGTH`, truncate in `stringify`; add `project_id` and `confine_project_path` to the SQLite and spreadsheet commands. Markdown: split `attrText` on the NUL markers, plus a test. GIF: check `maxPixelBytes` before the canvas allocation. ODT: cap the inflated size (#869). |
| 9 | 25, 27, 33, 34 | `services/mail_ai.rs` (`chat`), `commands/ollama.rs` (`installed_match`, `is_remote_entry`), `services/root_mcp.rs` (`Identity`, `record_read_mail`, `task_view`, `event_view`), `services/root_mcp_mail.rs::call`, `LocalModelMenu.tsx`, `src/lib/todoBoard.ts`, `MailAiMessageActions.tsx`, `services/mail_store.rs::file_agent_drafts`, `commands/root_mcp.rs:354` | Mail stays local: refuse a remote (`-cloud`) model in `mail_ai::chat` and in the local-model read tools (record the tab's model in `Identity` at spawn; fail closed on an unreadable `/api/tags`); skip remote models in the single-resident auto-assign. Stamp `from_mail` provenance on cards/events built from a mail and serve them redacted and marked `external` (decision E3). `record_read_mail` returns `Result` and refuses the read on failure; add a model-keyed marker. Filing compares agent-origin staged rows. Audit refusals with a fixed category. |
| 10 | 26, 32 | `services/caldav.rs` (`dav_reply`, discovery, list/put/delete/etag/access), `commands/caldav.rs`, `src/stores/calendar/caldav.ts::pushRow`, `commands/calendar.rs::merge_caldav_calendar_in`, `services::local_loss` | Pass a fixed credential origin (`base_url`; during discovery the typed URL) to every hop and check stored collection/resource hrefs with `credentials_may_follow(base_url, href)` before any request; refuse an `http:` href under an `https` origin (decision E2b). A failed push marks the row dirty; the merge keeps a dirty row, lists it in the existing conflict dialog and retries; any overwrite of a dirty row goes through `local_loss`. |
| 11 | 21, 38 | `src/components/files/openFileEntry.ts`, `commands/apps.rs::open_file`, `TerminalReaderChanges.tsx`, `NotebookView.tsx`, `SkillsLibraryView.tsx`, `MarkdownPromptField.tsx`, `markdown.ts::safeHref` | No-viewer double-click: the shared confirm dialog naming the file and that the OS will open it; launcher types and executable-bit files refused or always confirmed (decision C2). Same for Reader change cards. Give the three markdown hosts DevTodoView's click guard, route file links through `openLinkedFile` and http(s) through `routeUri`; `safeHref` refuses `\\`, `/\`, `\/`. Optional app-wide navigation gate (decision D6). |
| 12 | 20 | `services/mobile_control/live_pwa.rs`, `scripts/package-dev.sh`, `src-tauri/build.rs:107-116`, `services/dev_build.rs` (`queue_if_behind`), the dev launcher | Per decision B1/C3. Phone app: serve only from a host-only folder no fence binds, filled by an unfenced step (launcher adoption or an "Update phone app" action), and refuse links, foreign-owned or group/other-writable files in `live_pwa::load`; or drop `live_pwa`. Dev-build queue: require a click, or queue only HEADs the user's session made. Launcher adoption: document the residual or verify the artifact. |
| 13 | 35, 36 | `services/remote_sync.rs::rsync_pull_args` (+ arg tests), `commands/sync.rs:1782`, `commands/tex.rs` (`preview_env`, engine choice, Build env) | rsync: `-rt` (or `--no-specials --no-devices`), `--max-size=<MAX_SYNC_FILE_BYTES>`, `--no-recursive`; record only regular files in the manifest. TeX: previews add `openin_any=p` and never auto-escalate to LuaTeX for a hover; check whether Build's LuaTeX writes are confined and add `openout_any=p` to Build if not. |
| 14 | — | `services/sandbox.rs:49`, `docs/threat_model.md` | Fix the container-mount comment. Add the scope-less `/api/v1/inbox` upload to tier 0 of the threat model. |

Final: full gates (`AGENTS.md` → Gates), `npm run backend:stale`, and every
fixed row in `docs/threat_model.md` marked.

## Run 2026-10-08 — fixed decisions and agent steps

Branch `threat/1008` in `.claude/worktrees/threat1008`; handoff
`docs/threat_recheck_2026_10_08_handoff.md`. This run does plan steps 1, 2,
3, 6, 8, 13 and 14. Steps 4, 5, 7, 9, 10, 11 and 12 wait for their
decisions and are out of scope.

Fixed decisions (not up for review):
- **A1 = per-scope.** `.vibe/.env`, `.aider/oauth-keys.env`,
  `.config/mini-swe-agent/.env` and Cline's `providers.json` leave the shared
  login set and become per-scope files, like Continue's and Crush's mixed
  files. A user signs in to those CLIs once per scope. Login folders
  (CodeBuddy, Kimi) reconcile only an allowlist of file names. No content
  validator.
- Step 2's spawn-time refusal list applies to `opts.env` entries that came
  from a persisted layout, not to variables Tabtivity itself inserts.

| Agent step | Plan step | Gaps | Main files |
|---|---|---|---|
| 1 | 1 | 16 | `commands/agents.rs`, `services/agent_auth.rs`, `services/agent_home.rs` |
| 2 | 2 | 17 | `services/terminal_service.rs`, `terminal/mod.rs`, `services/launch_prep.rs` |
| 3 | 3 | 18 | `services/git_push_mcp.rs`, `services/root_mcp.rs`, `commands/terminal.rs`, `services/agent_fence.rs` |
| 4 | 6 | 29, 30 | `services/agent_session.rs`, `services/agent_turn.rs`, `services/git_guard.rs`, `services/agent_fence.rs`, `services/home_io.rs` |
| 5 | 8 (backend) | 24, 37, 39 | `commands/sheets.rs`, `commands/sqlite.rs`, their callers in `SqliteView.tsx`/`TableView.tsx` |
| 6 | 8 (frontend) | 28, 40, 41 (+ ODT #869) | `src/lib/viewers/yaml.ts`, `FileViewerPane.tsx` (error boundary), `markdown.ts`, `gif.ts`, `OdtView.tsx` |
| 7 | 13 + 14 | 35, 36 | `services/remote_sync.rs`, `commands/sync.rs`, `commands/tex.rs`, `services/sandbox.rs:49`, `docs/threat_model.md` |

### Plan review notes (2026-10-08, against `6194ce1f`)

Every cited file and function exists and every gap is still present. Line
numbers below are at `6194ce1f`. Choices marked **Chosen** settle open
questions for the implementer. They do not change the fixed decisions.

**Agent step 1 (gap 16, A1 per-scope)**
- Code: the registry is `commands/agents.rs:162` (Cline), `:173` (Vibe),
  `:190` (aider), `:375` (mini-swe-agent), `:325` (CodeBuddy dir), `:409`
  (Kimi dir). In `services/agent_auth.rs`: `reconcile_file` `:306`,
  `reconcile_dir` `:368`, `import_from_user_home_in` `:594`, `copy_dir`
  `:686` (recursive), `sign_out_in` `:701`. The keeper starts at
  `lib.rs:1300-1302` (`import_once`, then `start`).
- Set the four rows' `auth_paths` to `&[]`. Fix the doc comment at
  `commands/agents.rs:34-41`: Vibe, aider, mini-swe-agent and Cline now sit
  with Continue/Crush as per-scope. `LoginStatus.shared` becomes `false` for
  them, so `SettingsSubPanels.tsx:748` drops them from the shared-login list
  by itself. Adjust the English `settings.agentLoginsHelp` (`i18n.ts:1852`):
  "a keyring or a database" no longer covers every unlisted CLI.
- **Already-shared copies, concretely.** Each of the four CLIs has exactly one
  shared path, so its whole store dir goes: `<state>/agent-auth/vibe/`
  (`.vibe_.env`), `aider/` (`.aider_oauth-keys.env`), `mini-swe-agent/`
  (`.config_mini-swe-agent_.env`) and `cline/`
  (`.cline_data_settings_providers.json`), each with its `.placed/`,
  `.account` and `.blocked`. Every existing home holds its own copy (own
  inode since 2026-09-26). Once the paths leave the registry the keeper never
  touches those copies again, so they become per-scope files as they are.
  **Chosen:**
  - Fenced scope homes and `*.local` homes keep their copy. The login
    survives in every scope that has one. Residual for row 16: content planted
    before the fix stays in the fenced homes it already reached. Nothing new
    spreads.
  - The Host home (`agent-homes/host`, unfenced) loses its copy when the
    copy's sha256 equals the store's current bytes or
    `.placed/host/<leaf>`, meaning Tabtivity put it there. A copy that differs
    from both is the Host session's own unadopted write and stays.
  - Implement this as an idempotent `agent_auth::retire_shared_paths_in(state_dir)`
    with a const table `RETIRED: &[(cli, rel)]`. It runs at `lib.rs:1300`
    before `import_once` and keys on the store file existing, so it needs no
    marker. Order: Host check first, then delete the store dir. The same
    function cleans the login folders (next bullet).
  - Users who want one key everywhere can put the file in the Tabtivity-wide
    layer (`services::agent_global`), which agents cannot write. Say so in
    `docs/context/agent_authority.md`. Do not auto-migrate the store's copy
    into that layer: the copy may be agent-written.
- **Login-folder allowlists.** The repo does not record the file names. I
  read them off the published bundles:
  - CodeBuddy: `@tencent-ai/codebuddy-code` 2.162.0, `dist/codebuddy.js`
    `getAuthSavePath`. One file, `<authId>.info`. The default id is
    `Tencent-Cloud.coding-copilot` (`product.json`). Self-hosted endpoints get
    `<id>-<x>-<host>` (`resolveCustomAuthId`). Logout renames the file to the
    backup `<stem>.<ISO-ts with - for :.>.<pid>.<uuid>.info` and writes
    `<file>.logged-out`. Temporaries are `.<file>.<pid>.<uuid>.tmp` and the
    lock is the dir `<file>.lock`.
  - Kimi Code: `@moonshot-ai/kimi-code` 2.1.1, `FileTokenStorage`.
    `credentials/<name>.json`, default `kimi-code.json`; other OAuth keys give
    `<key>.json`, with no leading dot and no `/`. Temporaries are
    `<name>.json.tmp.<pid>.<hex>`.
  - **Chosen allowlist** (an `AuthPath` field such as `names: fn(&str) -> bool`,
    or a match in `reconcile_dir`):
    - Kimi: `^[^./][^/]*\.json$`.
    - CodeBuddy: `^[^./][^/]*\.info$`, minus names matching
      `\.\d{4}-\d\d-\d\dT[0-9-]+Z\.\d+\.[0-9a-f-]{36}\.info$` (the logout
      backups would otherwise pile up in every home).
    - `.logged-out` markers stay per scope.
  - Today's code already adopts any of these, including a temporary caught
    mid-write.
- Apply the allowlist in all three places: `reconcile_dir` (both adopt and
  place), `import_from_user_home_in` (replace the recursive `copy_dir` with a
  one-level, allowlisted copy) and `remove_copies`/`status_in` (count only
  allowlisted names as signed in).
- Migration for the folders, inside `retire_shared_paths_in`: delete every
  non-allowlisted file in `agent-auth/{codebuddy,kimi}/<leaf>/` and its
  `.placed/*/<leaf>_<name>` records. Remove a home's copy of such a name only
  where its digest equals that home's placed record, meaning Tabtivity put it
  there.
- Remaining shared files: under the fixed decision there is no content
  validator. The Host home gets the same credential files as every scope,
  with the Pi check and account guard kept. The plan's sentence "the Host home
  never receives a shared file that has not passed the check" therefore
  reduces to the Pi check. Record that in row 16. Not re-surveyed here: Goose
  `secrets.yaml`, OpenCode `auth.json` and Qoder `.auth`. List them as
  "credential-only per the 2026-09-25 survey" in the row.
- Fix stale prose: `agent_home.rs:17-18` ("hard-linked"),
  `docs/context/agent_authority.md:140,283`, `sandbox.rs:49` (step 7 does
  that one).
- Out of scope, note only: on Windows Node's `os.homedir()` follows
  `USERPROFILE`, not `HOME`, and the CodeBuddy path is Linux-only. On macOS
  the login sits under `Library/Application Support/…` and is simply not
  shared.
- Tests (in `agent_auth.rs`):
  - no registry row lists a `.env`, `providers.json` or other config path;
  - retire: store dir gone, fenced copy kept, Host copy equal to the store
    removed, divergent Host copy kept, a second run is a no-op;
  - allowlist: `kimi-code.json` shared, while `kimi-code.json.tmp.1.ab` and
    `x.env` are neither adopted nor placed; CodeBuddy default `.info` shared,
    while the backup name and `.logged-out` are not;
  - import copies only allowlisted names.
- Update the existing tests:
  - `a_local_model_home_receives_logins_but_never_feeds_them_back` (`:905`)
    uses Cline's `providers.json`. Move it to e.g. `.codex/auth.json` and
    keep its receive-only intent.
  - `a_login_directory_is_reconciled_file_by_file` (`:1082`) uses Kimi
    `token`. Rename it to `kimi-code.json`.
- Acceptance: Settings lists Vibe, aider, mini-swe-agent and Cline nowhere
  among the shared logins; `npm run backend:stale` reported; row 16 marked
  with the residual.

**Agent step 2 (gap 17)**
- Code: `sanitize_untrusted_layout` `terminal_service.rs:403`,
  `sanitize_tab_layout` `:425`, test `known_commands_keep_every_field_except_resume_args`
  `:807`, `custom_agent_specs` `:359`, env applied at `terminal/mod.rs:1461`.
  The TAB_UID rebuild is now at `src/stores/tabs.ts:5471-5473`.
- `sanitize_untrusted_layout` covers all three untrusted doors:
  `adopt_untrusted_session` (`:604`, used by `.tabtivityproj` import
  `project_transfer.rs:1434` and by folder adoption `projects.rs:2709`), and
  the one-time `migrate_project_sessions_once` (`:659`). No other door was
  found (`strip_untrusted_project_fields` drops `tab_layout` on import).
- Dropping `env` at the untrusted doors loses `TAB_UID` for every agent
  except Codex and Vibe. New tabs set `TAB_UID = sessionId` for every
  resumable agent (`newTabItems.ts:158`). **Chosen:** widen the restore
  rebuild at `tabs.ts:5471` to every tab with `isResumableAgentTab` and a
  `sessionId`, so turn binding (`launch_prep.rs:520`) survives. Test in
  `CenterPanelSessionRestore.test.tsx`.
- `embedExec` is executed: `EmbedPane` opens on mount
  (`EmbedPane.tsx:30-37`) → `open_file` handler → `launch_command`
  (`apps.rs:598-602`). External embeds are filtered as non-restorable on
  load today, so this is defence in depth. Drop `embedExec` at the untrusted
  doors as planned.
- **Found while checking: the `env` hole is wider than loader variables.**
  - `launch_prep.rs:400-412` uses `entry().or_insert` for `TABTIVITY_SCOPE`
    and `TABTIVITY_PROJECT_DIR`. A persisted value therefore wins. A planted
    `SCOPE` makes the agent shim fence a CLI typed in that shell tab into
    *another* scope.
  - The shim (`agent_bin.rs:71`) execs the real CLI **unfenced** when
    `TABTIVITY_HOST_SESSION` or `TABTIVITY_AGENT_FENCE` is set, and a
    persisted env can set either.
  - `tmux_local::is_fence` (`:308`) also trusts `AGENT_FENCE`.
  - **Chosen:** at the top of `launch_prep::prepare`, remove from
    `opts.env` every Tabtivity control variable: `AGENT_FENCE`,
    `HOST_SESSION`, `SCOPE`, `PROJECT_DIR`, the five `*_MCP_TOKEN` vars,
    `PUSH_PREFLIGHT` and the API-key carriers, in both brand and legacy
    (`ELDRUN_`) spellings. Then set `SCOPE`/`PROJECT_DIR` with `insert`. The
    frontend never sends these (only `TAB_UID` and `LOCAL_MODEL` via
    `envName`). That keeps within the fixed decision: these are variables
    Tabtivity itself inserts, so an incoming value is never legitimate.
    Before relying on it, `rg` every `prepare(` caller and every internal
    `PtyOptions` builder.
- Loader-variable denylist ("from a persisted layout"). The spawn cannot tell
  where a variable came from, so apply the list where layouts are loaded. Put
  a helper `terminal_service::strip_persisted_env(tab, custom)` in
  `sanitize_tab_layout`'s known-command branch, which runs for trusted
  state-dir loads too: `load_terminal_session` `:252`, `workspace.rs:817`.
  Also call it from the headless owner's `mobile_control/headless.rs:740`
  (`launch_options`), which reads the stored record raw and so bypasses the
  sanitizer.
  - List: `PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`,
    `PS4`, `SHELLOPTS`, `BASHOPTS`, `IFS`, `ZDOTDIR`, `HOME`, `XDG_*_HOME`,
    `INPUTRC`, `GIT_*` (`GIT_CONFIG_*`, `GIT_SSH*`, `GIT_ASKPASS`,
    `GIT_EXEC_PATH`, `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND`, …),
    `SSH_ASKPASS*`, `EDITOR`, `VISUAL`, `PAGER`, `NODE_OPTIONS`, `NODE_PATH`,
    `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`,
    `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, and the
    control variables above.
  - Custom agents legitimately carry `env` (`types/index.ts:111-112`,
    settings.json). **Chosen:** extend `custom_agent_specs` to return each
    spec's `env`, and for a custom-agent tab keep a denylisted key only when
    the spec names the same key with the same value, as `rebuild_resume_args`
    already does for `resumeArgs`.
  - Built-in tabs never persist `PATH` or `LD_*` today (checked
    `src/stores`, `src/lib/agents`, `src/components/tabs`).
- Tests:
  - an untrusted shell/`claude`/`bash` tab with `env` and `embedExec` loses
    both, and its `TAB_UID` is rebuilt on the frontend;
  - keep the trusted-path test at `:807`, minus denylisted keys;
  - a state-dir layout with `PATH`/`LD_PRELOAD`/`TABTIVITY_HOST_SESSION`
    loses them while `VIBE_HOME` and `TAB_UID` stay;
  - a custom agent's spec env survives a round-trip, and a persisted value
    that differs from the spec is dropped;
  - `prepare` with an incoming `TABTIVITY_SCOPE=other` spawns with its own
    scope, and an incoming `HOST_SESSION` is gone;
  - `headless::launch_options` strips the list.
- Size: this is about one day of work. Keep it in one agent step.

**Agent step 3 (gap 18)**
- Code: `preflight_command` `git_push_mcp.rs:552`, called per round from
  `preflight` `:585`. The proposal is built at `:745` and runs after the
  card at `:845`. `grant_git_push` is at `root_mcp.rs:904`, `Identity` at
  `:89`, `PushBinding` at `:110`. `register_tab`/`fenced_scope_of_tab`/
  `on_tab_gone` are at `agent_fence.rs:1740/1753/1806`. `pty_kill` is
  `commands/terminal.rs:404`, `pty_kill_scope` `:426`. Teardown calls sit at
  `terminal/mod.rs:1016` (`kill_all`), `:1092` (`teardown_taken`) and
  `:1278` (reader-task end, already generation-guarded by `route_close`).
- The Pusher token is minted in `prepare` at `launch_prep.rs:489`, *before*
  the fence decision (`:730-762`). The identity therefore cannot know the
  scope at mint time.
  - **Chosen:** add `fence_scope: Option<String>` to `PushBinding`. Set it
    where `fenced_registration` is set (`launch_prep.rs:762`), through a
    `TokenStore` call keyed by the token in `opts.env[GIT_TOKEN_ENV]`.
  - Copy it into the proposal at `:745`.
  - `preflight_command` builds the one-shot fence from it. On `None` it
    refuses with `FenceUnavailable` on every platform, keeping the Windows
    message.
  - The host branch survives only behind `#[cfg(test)]`, for the existing
    hook tests (`:1669-1695`). A Pusher exists only for local,
    non-container, non-remote project agents, which are always `Fenced` on
    Linux/macOS, so nothing legitimate loses.
- Generations. `PtyEntry` (`terminal/mod.rs:757`) has no generation, and
  `route_open`'s seq is minted after `insert`. **Chosen:** mint one spawn seq
  before `reg.insert` (`:1159`), store it in `PtyEntry`, expose it on
  `TakenPty`, and pass it into `PreparedLaunch::commit(seq)` → `register_tab(id, scope, seq)`.
  Then `on_tab_gone(id, seq)` does nothing (fence entry, `api_proxy` tokens,
  keeper kick) unless the registered seq matches. Apply the same guard to
  `agent_turn::on_tab_gone` and `root_mcp_review::on_tab_gone` at the
  `pty_kill` call sites.
  - When `take()` returns `None`, `pty_kill` skips the `on_tab_gone` calls:
    the reader-task end already cleaned up that spawn.
  - Use the route seq at `:1276`.
  - `rg PreparedLaunch` for other spawn paths (headless).
- Tests:
  - a stale `on_tab_gone(id, old_seq)` after a respawn leaves the new
    registration and its proxy tokens;
  - a Pusher whose binding has no fence scope is refused with
    `FenceUnavailable` and never runs the hook;
  - the binding is stamped only for a `Fenced` decision.

**Agent step 4 (plan step 6, gaps 29 and 30)**
- Lines moved:
  - `agent_turn.rs`: `bind_tab` record reads at `:138,148` (the spawn
    path); `resolve_event` `:218`, which runs on the watcher thread
    (`:524-533`).
  - `agent_session.rs`: `.prev` `:1462`, `.src` `:1472`, id record `:1488`,
    `.mode` `:1536`.
  - `git_guard.rs`: `commondir` `:100`, `.git` pointer `:128`.
  - `local_model_control_paths`: `agent_fence.rs:868`.
- Missing from the plan's list, also agent-writable and blocking on a FIFO:
  - Vibe `sessions/session_*/meta.json` (`agent_session.rs:121`);
  - transcript tails through `File::open` (`with_transcript_tail`,
    `agent_session.rs:667`). For these, use `O_NONBLOCK` plus an `fstat`
    regular-file check and keep the existing tail cap.
- Reuse what exists: `home_io::HomeFile::open_read` (`home_io.rs:329`)
  already does `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` plus an `fstat` regular-file
  check. Add one path-based sibling, e.g. `home_io::read_record(path, cap)`,
  with a 64 KiB cap. Do not add a third module. On non-unix keep the
  `symlink_metadata().is_file()` fallback; there are no FIFOs on Windows.
- Gap 30, **Chosen:**
  - Create the control paths through `HomeDir`/`HomeFile` (`mkdirat`,
    `openat(O_CREAT|O_NOFOLLOW)`, `unlinkat` for a link).
  - Then, immediately before the argv is built, re-`lstat` each path and
    compare dev/ino with the handle's `fstat`. Refuse the spawn on a
    mismatch (fail closed).
  - bwrap still opens the source by path afterwards, so a narrow window
    remains. Record it as the residual in row 30. `--ro-bind-fd` would need
    fds passed through the PTY spawn, which is out of proportion here.
  - On macOS, Seatbelt rules are by path; same residual.
- Tests:
  - a FIFO at `.turn`, `.src`, `.mode`, the id record, `commondir` and
    `meta.json` returns `None` without blocking (use a timeout);
  - an oversized record is refused;
  - a symlinked control path is replaced, and a swapped inode refuses the
    spawn.

**Agent step 5 (plan step 8 backend, gaps 24, 37 and 39)**
- The calamine bomb is wider than `.xlsx`:
  - `Xls` parses every sheet inside `open_workbook_auto`. A DIMENSIONS
    record (BIFF8 rows are u32) drives `cells.reserve(rows*cols)`
    (`calamine-0.36.1/src/xls.rs:617-620`) and aborts at *open*, before any
    check can run.
  - `read_shared_strings` and zip inflation are unbounded too.
  - `open_workbook_auto` also accepts `.ods`/`.xlsb`, although the UI only
    routes `.xlsx/.xls/.xlsm` (`fileUtils.ts:103`).
  - **Chosen:** run the read in a child process. Add a hidden helper mode
    of the main binary, `--sheet-read <path> <sheet>`, next to
    `--agent-shim`/`--fence-scope` in `main.rs:12-30`. Linux/macOS: set
    `RLIMIT_AS` (~2 GiB) and `RLIMIT_CPU`. Allow 30 s wall time. Return JSON
    on stdout, capped. An abort then kills only the child.
  - Inside the child, read xlsx/xlsm through `worksheet_cells_reader`
    (`xlsx/mod.rs:2520`) with row/column/cell caps, never through a `Range`.
    Refuse every extension except `.xlsx/.xlsm/.xls`.
  - Windows: a plain child process is enough; the abort stays contained.
- SQLite (`sqlite.rs:29,82,94`):
  - Add rusqlite features `hooks` and `limits` (`Cargo.toml:72`).
  - Use `progress_handler` with a ~5 s deadline, or the default-available
    `get_interrupt_handle()` from a watchdog thread.
  - Set `SQLITE_LIMIT_LENGTH` to 16 MiB, plus `SQL_LENGTH` and `EXPR_DEPTH`.
  - Set `PRAGMA trusted_schema=OFF` and `query_only=1`.
  - Clamp `limit` (u32 today) to 1000. Truncate `stringify` text to 4 KiB.
  - `COUNT(*)` on a view is under the same deadline.
- Confinement: add `project_id: Option<String>` to `read_spreadsheet`,
  `sqlite_tables` and `sqlite_page`. Call `fs::confine_project_path`
  (`fs.rs:2094`), copying `read_file_bytes`'s scope handling exactly so every
  view that opens today keeps opening.
  - Callers: `TableView.tsx:198`, `SqliteView.tsx:50,74` and the TeX
    workspace's spreadsheet use (mocked in `TexWorkspace.test.tsx:892`). Find
    its real call site and give it the project id.
- Tests:
  - a synthetic xlsx with cells at A1 and XFD1048576 returns a refusal,
    built with `zip` in-test (`rust_xlsxwriter` is not a dependency);
  - a crafted `.xls` DIMENSIONS ends the child, not the test process;
  - a recursive-CTE view is interrupted;
  - a path outside the scope is refused;
  - an `.ods` is refused.

**Agent step 6 (plan step 8 frontend, gaps 28, 40, 41 and ODT)**
- YAML: `Bail` is at `yaml.ts:556`; `parseYaml`'s catch at `:583-595`
  re-throws. The flow recursion is at `:1109/1176/1194/1201`. Block nesting
  recurses too: cap a shared depth counter (512) across flow *and* block
  nodes. `path` arrays are copied per level, which costs O(depth²) without
  the cap. Add a `yamlParse.tooDeep` key (English required).
- There is no error boundary anywhere in `src/`. Every viewer renders through
  `FileViewerPane.tsx` (the shared host). Add one `ViewerErrorBoundary`
  there, with a "Show source" fallback and i18n strings, reset on
  `path`/`viewer` change.
- Markdown: `attrText` is at `markdown.ts:172`, used at `:244`. The file
  holds literal NUL bytes, so read it with `rtk proxy grep -a`.
- GIF: besides the canvas at `gif.ts:311` (allocated before the check at
  `:362`), each frame's `lzwDecode(…, w*h)` allocates from the frame's own
  `w*h` (up to 65535² bytes) whatever the screen size. Check `frameBytes`
  against `maxPixelBytes` before `:311`, and refuse a frame larger than the
  logical screen.
- ODT: `unzipSync` at `OdtView.tsx:45`. Use fflate's `filter` to extract
  only `content.xml`/`styles.xml`/`meta.xml`, with a cap on the summed
  declared `originalSize` (e.g. 64 MiB). fflate sizes the output buffer from
  that field.
- Tests: deep JSON and deep YAML each give a `Bail` reason with no throw; the
  boundary renders its fallback when a child throws; alt text with
  math/code markers; a 30-byte GIF claiming 65535² is refused; an ODT over
  the cap is refused.

**Agent step 7 (plan steps 13 and 14, gaps 35 and 36)**
- rsync: `rsync_pull_args` `remote_sync.rs:805`. **Chosen argv:**
  - Replace `-a` with `-t -c --no-links --no-devices --no-specials --max-size=<MAX_SYNC_FILE_BYTES>`.
  - Drop `--recursive`: `--files-from` still creates the implied parent
    dirs.
  - No `-p`, `-o` or `-g`. That matches the SFTP floor, `pull_file`
    `:660`, which writes default modes.
- In `commands/sync.rs`, pre-filter the file list to `size <= cap` before
  `try_rsync_pull` (call `:1774`). In the record loop after an rsync (`:1783`),
  use `symlink_metadata`, record only a regular file within the cap, and skip
  the rest.
- Tests: update the args tests (`:1320,1347`); assert no `-a`, `-r` or
  `--recursive`. If `rsync` is on PATH, add a local→local test with a listed
  dir swapped for a FIFO and an oversized file.
- TeX:
  - `preview_env` is at `tex.rs:598`; previews run at `:1787,1882`; the
    engine hint picks LuaTeX at `:365,369`.
  - **Chosen:** hover previews never use LuaTeX. A Lua-only document gets no
    preview: return `None`, as for any failed preview, with no new UI.
  - Add `openin_any=p` to `preview_env`. Format and package lookups go
    through kpathsea search, and `-output-directory` sets `TEXMFOUTPUT`, so
    previews keep working. Verify with the engine test at `:2886`; add a
    test that a preview's `\input{<absolute temp file>}` is refused.
  - Build: check whether LuaTeX `io.open` writes on Build honour
    `openout_any`. If not, or if unsure, pass `openout_any=p` to Build's
    engine env too, and record the check in the handoff.
- `sandbox.rs:49`: the comment says shared login dirs are mounted. They are
  not (`:873-893`). Delete the line.
- Threat model: add `/api/v1/inbox` (`mobile_control/host.rs:4280-4284`,
  scope-less, 1 GiB, state dir) to Tier 0's phone-bridge row
  (`threat_model.md:113-117`).

**Ordering:** steps 2 and 3 both edit `launch_prep.rs` and step 4 edits
`agent_fence.rs` after step 3. Run them in the listed order.

**Blocking questions:** none. The one judgement call that goes beyond a
default is step 1's migration: fenced homes keep their existing copy, so
logins survive but a pre-fix plant persists there; the Host copy is
dropped. List it under "Flagged for user" in the handoff.

## Run 2026-10-12 — fixed decisions and agent steps

Branch `threat/1012` in `.claude/worktrees/threat1012`, from develop
`5d82c988`. Handoff: `docs/threat_recheck_2026_10_08_handoff.md`, new
sections under "Run 2026-10-12". This run does plan steps 4, 5, 7, 9, 10, 11
and 12. Another session's uncommitted CodeQL fixes sit in the main checkout
(39 files, `fs.rs`, `git_ci.rs`, `agent_fence.rs`, `root_mcp.rs`,
`mobile_control/*` among them); they are not on this branch, and landing
merges with whatever develop holds then.

Fixed decisions (not up for review; answered 2026-10-12, see "Decisions for
the user"):
- **A2:** agent CI reads only reach the repo confirmed for pushes, or one the
  user allowed once on an "Allow CI for <repo>" card (reuse the push-card
  flow and its store); anything else answers a new `ci_repo_unconfirmed`
  category. Plus the plan's defence in depth (a git dir that appeared after
  spawn is refused by push and CI).
- **D1:** viewer writes refuse every symlinked leaf, in-root links included;
  a dangling leaf link is refused too.
- **D3:** the deck keeps its automatic re-raster, writing only `.png` files
  under its own figure folder; absolute and `..` paths are refused for
  deck-written `src`/`texSrc`.
- **C2:** every no-viewer hand-off to the OS asks first, naming the file;
  launcher types (`.desktop`, `.exe`, `.jar`, `.lnk`, `.cmd`, `.bat`,
  `.vbs`, `.ps1`, `.app`, `.command`, `.sh`, … — the implementer completes
  the list per OS) and executable-bit files are refused outright with a
  message. Same for Reader change cards.
- **D6:** add an app-wide navigation gate on the `main`, `detached-*` and
  `present-*` windows that refuses navigation off the app origin.
- **E3:** mail-derived cards and events served to a cloud root tab keep
  title and notes, with URLs removed and an `external` mark. Agent writes to
  a CalDAV-synced calendar always stage for approval, whatever the level.
- **E2b:** refuse `http://` CalDAV entirely: discovery, stored hrefs and
  accounts added as http, with an i18n message saying why. No migration
  deletes an existing http account; it stops syncing and says so.
- **B1:** drop `live_pwa` (the no-relaunch phone update); the phone app
  always comes from the binary. Remove its build-side plumbing too.
- **C3:** keep auto-queueing dev builds from the window; document the
  residual in `docs/threat_model.md` and `docs/context/dev_builds.md`. The
  launcher adopts `target/release/<bin>` only when its hash matches one the
  unfenced build wrote into the state dir (no fence can write there).

| Agent step | Plan step | Gaps | Main files |
|---|---|---|---|
| 1 | 4 | 19 | `services/git_ci.rs`, `services/git_push_mcp.rs`, `services/root_mcp.rs` (`PushBinding`, `grant_git_push`), `services/git_release.rs` (`tip_ci`), `GitPushMcp.tsx` + `types/index.ts` (card) |
| 2 | 5 | 22, 31 | `commands/fs.rs`, `commands/mail.rs`, `services/mobile_control/files.rs` + `files_windows.rs` (`ProjectDir`) |
| 3 | 7 + 11 (gap 38 hosts) | 23, 38 | `DeckView.tsx`, `deckAssets.ts`, `NotebookView.tsx`, `SkillsLibraryView.tsx`, `MarkdownPromptField.tsx`, `DevTodoView.tsx`, `FileViewerPane.tsx` (link handler, shared), `markdown.ts::safeHref` |
| 4 | 11 (gap 21 + D6) | 21, 38 | `stores/windows.ts` (`openFile`), `commands/apps.rs::open_file`, `commands/mobile_control.rs::global_inbox_open`, `lib.rs` (navigation-gate plugin) |
| 5 | 9 (mail stays local) | 25, 33 | `services/mail_ai.rs`, `commands/ollama.rs`, `services/root_mcp.rs` (`Identity`, `record_read_mail`), `root_mcp_mail.rs`, `LocalModelMenu.tsx` |
| 6 | 9 (provenance, drafts, staging) | 27, 34 | `MailAiMessageActions.tsx`, `root_mcp.rs` (`task_view`, `event_view`, `todo_list`), `root_mcp_review.rs::call` (CalDAV staging), `mail_store.rs::file_agent_drafts`, `commands/root_mcp.rs:361` |
| 7 | 10 | 26, 32 | `services/caldav.rs`, `commands/caldav.rs`, `stores/calendar/caldav.ts`, `commands/calendar.rs`, `CalDavAccountDialog.tsx` |
| 8 | 12 | 20 | `mobile_control/live_pwa.rs` (removed), `mobile_control/host.rs`, `build.rs`, `scripts/package-dev.sh`, `scripts/backend-stale.sh`, `start-tabtivity-dev-build.sh`, `start-tabtivity-tauri-hotreload.sh`, `docs/context/dev_builds.md` |

### Plan review notes (2026-10-12, against `9611749e`)

All 13 gaps are still in HEAD; no other work has fixed any of them. Line
numbers below are at `9611749e`. Cited code that moved, or was named wrong, is
corrected here, and the table above is updated to match. Notes marked
**Chosen** settle open implementation questions. They do not change the fixed
decisions. Order: 1, 2, 3, 4, 5, 6, 7, 8 (3 after 2, 6 after 5: both touch
`root_mcp.rs`). The other session's uncommitted CodeQL edits in `fs.rs`,
`git_ci.rs`, `root_mcp.rs` and `mobile_control/*` will conflict at landing.
Keep hunks small and don't reformat.

**Agent step 1 (gap 19, A2)**
- Code: `git_ci::repo_of` `git_ci.rs:54` takes `branch.<b>.remote`, else
  `origin`, and its URL. `runs` `:243`, `run` `:262` and `security_alerts`
  `:351` call it and send `api_token` `:69`. They are dispatched from
  `git_push_mcp::handle_admitted` `git_push_mcp.rs:1316-1323`, and admission
  is at `:1144-1153`. `ProjectPolicy` `:63` holds `confirmed_url`, set by
  `decide` `:924` and `set_policy` `:102`. `git_hosting.rs:199-211` is
  `token_origins_for`. It is not an "origin add", so drop that citation.
- Sibling, same fix: the Release plan reads CI for whatever URL the branch's
  remote names, with the token (`git_release.rs:193-198`, `tip_ci`). Its
  pending/failed workflow names reach the agent in the refusal message. Run
  the same repo check before `tip_ci`. An unconfirmed repo answers
  `ci_repo_unconfirmed` there too.
- **Chosen, storage:** do not add a field to `ProjectPolicy`. It is
  `deny_unknown_fields`, so an older dev build would read the new key as
  "invalid push policy" and lose the whole lane. Keep a separate
  `entry.extra["git_ci_repos"]`: a list of lowercase `owner/repo` strings,
  patched through `projects::patch_project_entry` like `set_policy`. The
  allow check is `github_repo(remote url)` (lowercased) ==
  `github_repo(policy.confirmed_url)`, or that repo is listed.
- **Chosen, card:** add `Kind::CiRepo` to the existing proposal store
  (`Proposal` `:703`), with `url` set to the remote URL and `branch: None`.
  An unconfirmed CI read stages one card per (project, repo) and dedupes it
  against a pending one. It does not use the push rate or the
  `PENDING_LIMIT` of 2 (otherwise one CI card would block pushes). It answers
  `{"status":"refused","category":"ci_repo_unconfirmed"}`, with a message
  that a card is waiting and the agent should ask again after the user allows
  it. `decide` with `Kind::CiRepo` appends the repo and ends in a new
  `Status::Allowed` (`"allowed"`). Dismiss works as it does for pushes. No
  new Tauri command is needed: the card reuses `git_push_mcp_decide`/`_clear`
  (`commands/root_mcp.rs:844-851`). Under `keyring_free()` (the Mobile host)
  no card can be decided, so answer `ci_repo_unconfirmed` and tell the agent
  to allow it from the window.
- Frontend: `types/index.ts:1166,1179` (`kind`, `status`);
  `GitPushMcp.tsx:96-130` renders a "ci" card ("Allow CI for <owner/repo>",
  Allow/Dismiss). New `gitPushMcp.ci*` strings in English, and an
  `UntestedTag` with a register row (`gitPushMcp.ciAllow`).
- Defence in depth, the git dir that appeared after spawn: in
  `root_mcp::grant_git_push` (`root_mcp.rs:932`), walk up from `dir` the way
  git discovery does (`symlink_metadata` of each `<ancestor>/.git`). Record
  the first hit's `(dev, ino)` in a new `PushBinding.git_at_spawn:
  Option<(u64,u64)>` (`root_mcp.rs:115`). In `handle_admitted`, before
  `git_push`, `git_release` and every `ci_*`, redo the walk. If there was no
  git dir at spawn, or the identity differs, refuse with a new
  `Category::RepoChanged` (`"repo_changed"`) and say "restart the tab". On
  Windows use `file_index` from `GetFileInformationByHandle`, or skip the
  check: no fence there. Update `Category::as_str`/`from_str`, the tool
  descriptions and `INSTRUCTIONS`, and the `PushBinding` test at
  `root_mcp.rs:3459`.
- Tests: CI on an unconfirmed repo refused, card staged once, allowed after
  `decide`; CI on the confirmed push URL passes; owner/repo compared in
  lowercase; a `git init` after spawn → `repo_changed` for push and CI; an
  old `projects.json` without `git_ci_repos` round-trips unchanged;
  `tip_ci` is not called for an unconfirmed repo.
- Docs: `docs/context/git_push_mcp.md` (CI repo rule, card, `repo_changed`).
  Threat model row 19 (and drop its "macOS residual" wording).

**Agent step 2 (gaps 22, 31, D1)**
- Code moved: `resolve_for_confinement` `fs.rs:2124`, `confine_abs_within`
  `:2141`, `read_file_text_local` `:1572`, `write_file_text_local` `:1626`,
  `write_file_bytes_local` `:1756` (still a bare `fs::write`),
  `read_file_bytes_local` `:1847`, `file_mtime_local` `:1890`,
  `file_size_local` `:1929`, `detect_mime_local` `:1465`. Mail:
  `emails_dir_in` `mail.rs:4951`, `write_unique_in_dir` `:5008`, caller
  `:4919-4931`.
- `services::files::ProjectDir` does not exist. The handle walk is
  `services/mobile_control/files.rs:230` (Unix, `pub(super)`) and
  `files_windows.rs:56` (Windows, `pub(crate)`, NtCreateFile
  `FILE_OPEN_REPARSE_POINT`, refuses every reparse type). **Chosen:** make
  that `ProjectDir` `pub(crate)` on both platforms and reuse it. Do not use
  `home_io::HomeDir`: its writes are temp+rename at `0600`, and on Windows it
  is path-based. Add one method to both platforms: `open_existing_for_write(name)`
  (Unix `openat(O_WRONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)`, `fstat` regular,
  then `set_len(0)`; Windows FILE_OPEN + GENERIC_WRITE +
  `FILE_OPEN_REPARSE_POINT`, refuse a reparse point). `create_file` (O_EXCL)
  exists.
- One helper in `fs.rs`, `open_confined(path, roots, mode)`. It canonicalizes
  the parent, picks the longest allowed root it lies under, and walks the
  rest with `ProjectDir::open_root` + `lookup_dir` (every component is
  link-free after canonicalize, so a swap after the check fails closed). For
  writes it opens the leaf with `O_NOFOLLOW`. **D1:** for writes, a leaf whose
  `symlink_metadata` is a link (dangling or not) or a reparse point is refused
  with "… is a link; viewers do not save through links". Reads canonicalize
  the whole path (in-root links still read, as today), then open the
  canonical path through the same walk, so a raced swap is refused instead of
  followed. Refuse any `..`/non-normal component outright. Today a lexical
  `missing/../..` passes the prefix check and only fails at `fs::write`.
- `resolve_for_confinement` itself: use `symlink_metadata` instead of
  `exists()`, so `confine_project_path`/`confine_user_path` callers stop
  treating a dangling link as a new file.
- Keep `write_project_file{,_bytes}_local` (`:990`, `:1019`) as they are. They
  follow an in-root link on purpose, and the test
  `write_project_file_still_saves_through_a_link_inside_the_project`
  (`:3390`) pins that. They are drag-drop/project writes, not viewer saves.
- Mail: replace `emails_dir_in` + `write_unique_in_dir` with one walk.
  `ProjectDir::open_root(root)`, `create_dir(name)` + `lookup_dir(name)`
  (which refuses a link), then `create_file(candidate)` in a loop on
  `AlreadyExists`/`ELOOP`. Return the path for display only. The
  `mark_downloaded(&target)` call afterwards is by path: accept that, or add
  an fd variant (`fsetxattr`).
- Frontend: saves surface the backend string today. Check that deck autosave
  (`DeckView.tsx:443`) and the figure poll show the link refusal once rather
  than retrying every tick.
- Tests (Unix): a dangling leaf link is refused and its target not created;
  an in-root symlinked leaf is refused for `write_file_text`/`_bytes` and
  read fine; a regular-file save keeps its inode and mode; a new file is
  created `O_EXCL`; `missing/../x` is refused; an emails folder swapped for a
  link after the handle was opened writes into the real folder. Windows: run
  the msvc clippy/check cross-check (AGENTS.md) for the new `files_windows.rs`
  method.

**Agent step 3 (gap 23, D3; gap 38 hosts)**
- Deck code moved: `texFigureDir` `DeckView.tsx:150` (`<deck>.tex-figures`),
  `rasterizeInto` `:1119` (the one PNG write), `addTexFigure` `:1134`,
  `recompileTexObject` `:1200`, the poll `:1243-1300`. `resolveRel`
  `deckAssets.ts:26` passes absolute paths. `sidecar.ts:288-294` keeps any
  string.
- **Chosen:** one guard `figureTarget(deckPath, src)`. It returns the
  absolute path only when `src` is relative, has no `..` or empty component,
  sits directly in `texFigureDir(deckPath)` (one level) and ends in `.png`.
  `figureSource(deckPath, texSrc)` is the same with `.tex`. Apply both in
  `rasterizeInto` and before every `compile_tex` of `texSrc` (poll, Recompile,
  edit), not only in the poll: D3 covers every deck-written path. A refused
  object gets a one-time notice (new `deckView.figureOutside` string) and is
  skipped. Image reads (`:928`) keep `..` and absolute `src`: a picked figure
  above the deck is legitimate, and reads are confined anyway.
- Sibling data-loss bug, same file: `generateBase` (`:991-1003`) decides
  "no `.tex` yet" from `readFileText` failing. That also fails for a
  non-UTF-8 or over-cap `.tex`, which then gets overwritten. Decide on
  `fileMtime` instead.
- Gap 38 hosts at HEAD: `NotebookView.tsx:76`, `SkillsLibraryView.tsx:518`,
  `MarkdownPromptField.tsx:194` (no click handler). The model to copy is the
  markdown viewer's `onPreviewClick` (`FileViewerPane.tsx:8300-8345`), not
  DevTodoView's bare `preventDefault`. **Chosen:** move its link half into
  one helper (e.g. `src/lib/viewers/markdownLinks.ts`,
  `onMarkdownLinkClick(e, { basePath, tabKey })`). It handles `#` anchors,
  local file links via `resolveLocalHref` + `openLinkedFile`, and
  `preventDefault` on every other anchor without a `target`. Use it in the
  viewer, the three hosts and DevTodoView. A host with no file context (the
  prompt field) only prevents. External links already carry
  `target="_blank"` (`markdown.ts:275,299`) and stay as they are.
- `safeHref` (`markdown.ts:21`) and `isLocalHref` (`:70`): first strip
  ASCII tab/CR/LF, as the URL parser does, then refuse any href whose first
  two characters are both `/` or `\`. Today `\\host/x`, `/\host` and
  `\/host` pass, and the URL parser treats `\` as `/` on every platform, not
  only Windows. Tests: those three and `/\t/host` are refused; `docs/a.md`
  and `C:\x` still pass.
- Tests: `figureTarget` table (absolute, `..`, other folder, `.svg`, nested →
  null); the poll does not write for a hostile deck; a link click in each host
  calls `preventDefault` (RTL).

**Agent step 4 (gap 21, C2; D6)**
- Code: `openFileEntry.ts:50-56` is one of many OS hand-offs. Others call
  `useWindowsStore.openFile` directly: `DownloadsSection.tsx:171` (browser
  downloads), `FileBrowser.tsx:367`, `ProjectBlobPane.tsx:647`,
  `commitFileDrop.ts:373`, `FileViewerPane.tsx:652`, `EmbedPane.tsx:35`, plus
  terminal path links (`lib/terminal/pathLinks.ts:177`) and Reader change
  cards (`TerminalReaderChanges.tsx:282-305`), both through `openFileEntry`.
  The backend is `open_file_blocking` `apps.rs:552`, OS default at `:625`.
- **Chosen, choke points:** the confirm goes in the store's `openFile`
  (`src/stores/windows.ts`) whenever no explicit `handler` is passed. That
  covers every caller above, Shift+double-click included. The launcher
  refusal goes in the backend, on the OS-default path only (`effective ==
  None`). A user-configured default app or an explicit handler is the
  user's choice. Resolve the path (`fs::canonicalize`) before the check, so
  `notes.txt -> run.desktop` is caught. Refuse:
  - Unix: a regular file with any execute bit.
  - Linux: `.desktop`, `.sh`, `.run`, `.AppImage`, `.jar`.
  - macOS: `.app`, `.command`, `.tool`, `.terminal`, `.pkg`, `.mpkg`,
    `.workflow`, `.scpt`, `.jar`.
  - Windows: every `PATHEXT` entry plus `.lnk`, `.url`, `.scr`, `.msi`,
    `.hta`, `.vbs`, `.vbe`, `.js`, `.jse`, `.wsf`, `.wsh`, `.ps1`, `.cpl`,
    `.reg`, `.appref-ms`, `.application`, `.msc`, `.jar`,
    `.settingcontent-ms`.

  Match case-insensitively. Return a fixed code (`open_refused_launcher`)
  that the frontend maps to an i18n message.
- No new command: add `check_only: Option<bool>` to `open_file`. The store
  calls it first, and shows the refusal or the confirm ("Open <name> with the
  system's default app?"). Only then does it make the real call. Same
  refusal for the phone's global inbox: `global_inbox_open`
  (`commands/mobile_control.rs:213`) is an unprompted OS open of a file the
  phone uploaded. Give it the backend check, and make its frontend caller
  confirm.
- The confirm uses the shared dialog scheme. For an imperative ask from
  non-React code, copy `lib/execTrust.ts` + `ExecTrustHost.tsx` (or
  `stores/remote/syncConfirm.ts` + `SyncConfirmDialog.tsx`). Mount the host
  in detached windows too. New strings, `UntestedTag` + register row
  (`openExternalConfirm`).
- D6: `main` comes from `tauri.conf.json`. `detached-*` comes from
  `subwindow.rs:303`, `present-*` from `presenter.rs:124`, the connect window
  from `connect.rs:142`. **Chosen:** one tiny plugin,
  `tauri::plugin::Builder::new("nav-gate").on_navigation(…)`, registered in
  `lib.rs` (`.plugin(…)` near `:2373`). It covers every webview, the
  config-created `main` included. It skips labels that have their own gate
  (`browser-*` live windows `browser.rs:337`, print windows
  `print_native.rs:189`). For the rest (`main`, `detached-*`, `present-*`,
  and the connect window, which loads the app origin with IPC too) it allows
  only:
  - the app origin: `tauri://localhost`; `http://tauri.localhost` on
    Windows; the configured `devUrl` origin in a dev build;
  - `about:blank`, `about:srcdoc`;
  - `blob:` URLs of the app origin.

  Put the predicate in a pure, unit-tested function in `services/`. Click
  through mail HTML, the PDF viewer, the presenter, popouts and a hot-reload
  page reload: the handler may also fire for subframes.
- Tests: launcher table per OS (`cfg`-gated), exec-bit refusal, a link to a
  launcher refused, `check_only` writes and spawns nothing, the nav predicate
  table.

**Agent step 5 (gaps 25, 33)**
- Code moved: `mail_ai::chat` `mail_ai.rs:148`, its loopback check `:154`;
  `is_remote_entry` `ollama.rs:983`; `installed_match` `:995` (used once,
  `:1539`); the local read gate `root_mcp_mail.rs:1130-1150`;
  `record_read_mail` `root_mcp.rs:270` (ignores errors), `tab_read_mail`
  `:277`; the root-lane spawn `grant_root` `:812-830`; auto-assign
  `LocalModelMenu.tsx:221-240`.
- One backend helper `ollama::model_is_local(model) -> Result<(), &str>`:
  `GET /api/tags` + `installed_match`. An unreadable body →
  `model_not_installed` (fail closed); a cloud entry → `model_not_local`.
  Call it in `mail_ai::chat` after the loopback check and before
  `capabilities_of`. Cache the answer per model for about a minute:
  auto-classify calls `chat` for every new mail.
- Record the tab's model at spawn in a new `Identity.model:
  Option<String>`. Take the raw `TABTIVITY_LOCAL_MODEL`, else map the
  `VIBE_ACTIVE_MODEL` alias back the way `local_model_has_tools`
  (`root_mcp.rs:639`) does. Never read it from the Vibe home at read time.
  In the read gate, refuse when `model` is `None` or not local (the
  `LOCAL_READ_REMOTE` text, or a new `LOCAL_READ_CLOUD` text). `Identity`
  has about a dozen literal constructions (tests included); add the field
  to each, `None` for non-local callers.
- Gap 33: `record_read_mail` returns `io::Result<()>`. The gate latches the
  in-memory taint first, then refuses the read if the marker write fails.
  Add a model-keyed marker beside the tab one (hash of the alias, which is
  what keys the per-model `VIBE_HOME`, `ollama.rs:4594`). At spawn the taint
  is `tab_read_mail || model_read_mail`. Trade-off, state it in
  `docs/context/root_console.md`: once one tab of a model reads mail, every
  later tab of that model stages all its writes, until the marker is
  cleared. If a "clear conversations" action exists for a model, clear the
  marker there; otherwise document it.
- `LocalModelMenu.tsx:224`: skip `m.remote` models (the list already
  carries `remote`, `ollama.rs:917`) in the sole-resident auto-assign. The
  Mail role picker should mark cloud models as unusable for Mail, with an
  i18n hint.
- Tests: `model_is_local` over a tags body with a `-cloud` entry, an empty
  body and a local one; `chat` refuses a cloud mail model before
  `/api/chat`; the read gate refuses for a cloud or unknown model; a failed
  marker write refuses the read; a new tab of a tainted model starts tainted.

**Agent step 6 (gaps 27, 34; E3; CalDAV staging; audit reason)**
- Cards need no new stamp: a card from a mail already carries `task.mail`
  (`todoBoard.ts:1019-1042`, schema `CalendarTask.mail`
  `schema/calendar.rs:540`). The CalDAV merge keeps it
  (`commands/calendar.rs` task merge copies `local.mail`). So `todoBoard.ts`
  needs no change. Events have no link. Stamp `from_mail: {message_id,
  account_id}` (a top-level key, so it lands in `CalendarEvent.extra`) at
  both creation points in `MailAiMessageActions.tsx`: auto-create `:126-139`
  and the dialog's `saveEvent` `:203-212`. Add it to the TS `CalendarEvent`
  type as optional.
- **Provenance is sticky:** check that the event dialog's edit path and the
  calendar store keep unknown keys (a test that edits a stamped event and
  reads `from_mail` back). If they don't, have the backend update keep an
  existing `from_mail`. `carry_extra` (`commands/calendar.rs:886`) already
  keeps it across a CalDAV merge.
- Serving: `event_view` `root_mcp.rs:1681` and `task_view` `:1693`, plus the
  `todo_list` loop `:2362-2375`. A row is mail-derived when the event has
  `from_mail`, or the card has `mail`, or the card's `event` link points at a
  `from_mail` event (a card made from a mail-derived event). Treat it like
  `from_file`: `redact_value` (URLs only, title and notes stay) and
  `external: true`. **Chosen:** do this for every caller, not only cloud
  tabs. It is the existing `external` rule and needs no caller branch. Grep
  `root_mcp*.rs` for other places that echo an event or card row (write
  receipts, `proposals_list` rows) and send them through the same views.
  Update the two tool descriptions (`:1262`, `:1360`).
- CalDAV staging (`root_mcp_review.rs:495-500`, `automatic` at `:571`): a
  write touches CalDAV when any captured row (pre or post) has
  `caldav_href`, or its `calendar_id` is in a `CalDavCalendarRef.calendar_id`
  of `accounts.json` (`schema/caldav.rs:44`). An unreadable accounts file
  counts as touching (fail closed). Then `automatic = false`. Level `off`
  short-circuits before rows are known (`:501`). **Chosen:** for write tools
  under `off`, take the capture path with `automatic = !touches_caldav`, so
  non-CalDAV writes still land at once (logged as `applied`/undoable, a small
  visible change to `off`). CalDAV ones stage. Find how an applied agent row
  reaches the server (the window's `pushRow` on the change event, or
  nothing), and say so in `docs/context/caldav.md`.
- Gap 34 `mail_store.rs:2766`: `seen()` clears `staged` wholesale. Compare
  the agent rows instead: `origin == Some("agent")`, sorted by `staged_id`,
  on `(staged_id, filename, mime, size, source)`. Ignore only the user's own
  rows. First check why `staged` was cleared (the frontend's shown shape).
  Extend the test at `:4179`.
- Audit: the root lane now audits refusals at `commands/root_mcp.rs:361`
  (`security::audit`, no reason), not `:354`. Add
  `root_mcp::refusal_reason(reply) -> Option<&'static str>` mapping the fixed
  refusal texts (`LOCAL_READ_REMOTE`, `LOCAL_READ_OFF`, `ACCESS_NARROWED`,
  `LOCKED`, the pending limit, conflict/failed) to categories, and call
  `audit_reason` like the other lanes do (`:250`, `:275`).
- Tests: a mail-derived event and card served redacted + `external`; an
  ordinary one not; a card linked to a `from_mail` event redacted; a write
  into a CalDAV calendar stages under `off`, `destructive` and `all`; a
  non-CalDAV write under `off` still applies; a draft whose agent attachment
  changed is not filed.

**Agent step 7 (gaps 26, 32; E2b)**
- Code moved: `dav_reply` `caldav.rs:537`, credential origin = the requested
  URL `:546-549`; `credentials_may_follow` `:700`; `normalize_base_url`
  `:470` (accepts `http`); hrefs from the server via `absolute` `:736`,
  `collection_from` `:769`, discovery `:858-952`. Commands take the stored
  href: `caldav_fetch` `commands/caldav.rs:405`, `caldav_push` `:569`,
  `caldav_delete` `:642`, `caldav_resource_etag` `:674`,
  `caldav_refresh_access` `:697`. `Credentials` is built at `:165` and
  `:392`.
- **Chosen, fixed origin:** add `origin: Url` to `Credentials`
  (`caldav.rs:80`, keep the Debug redaction). Fill it from the account's
  normalized `base_url` in `credentials()` and from the typed URL in
  `caldav_discover`. `dav_reply` checks `credentials_may_follow(&cred.origin,
  &url)` on every hop, so the public signatures stay. Before the first hop of
  any request that starts from a server-named href, also refuse outright
  (with an error, not an unauthenticated retry) when it fails that check.
  This covers principal and home-set during discovery, stored collection and
  resource hrefs, and `caldav_account_upsert` (`:220`) rejecting picked
  calendars off-origin.
- **E2b:** `normalize_base_url` refuses `http` (flip the test at `:1776`).
  The reqwest `client()` (`:451`) gets `.https_only(true)` as a backstop for
  every hop and redirect. Return a fixed code (`caldav_http_refused`) that
  the frontend maps to one i18n message saying why (passwords and calendars
  would cross the network in clear; use https, e.g. a TLS proxy in front of
  Radicale). Loopback `http://localhost` is refused too, as decided; the
  message names it. Existing http accounts: nothing deletes them. The sync
  loop skips them and shows the message on the account (derive it from the
  stored `base_url` scheme). `CalDavAccountDialog.tsx` drops its http
  warning and refuses Save with the message.
- **Gap 32, design change:** `services::local_loss` does not fit. It is
  per-project and file-oriented (`local_loss.rs:98,130`), and a calendar
  row has no project. Drop it from this step. With the dirty flag below,
  nothing overwrites a dirty row automatically. Only the user's "Take
  server" in the existing conflict dialog does, which is already a decision.
  - Mark `caldav_dirty: true` (in the row's `extra`; it round-trips and older
    builds carry it) in the same local write that changes a row of a
    writable CalDAV calendar. That write is the calendar store's write path,
    where `pushRow` is called today. `caldav_push` clears the flag when it
    stamps href/etag (`stores/calendar/caldav.ts:476-483`).
  - `pushRow`'s catch (`:486-494`) keeps the row dirty. Its comment "the
    next sync will carry it" is wrong today: fix the comment.
  - The sync loop pushes a calendar's dirty rows (conditional on the stored
    etag) before it fetches. A 412 lands in `conflicts` as today.
  - `merge_caldav_calendar_in` (`commands/calendar.rs:928`) leaves a matched
    dirty event or task untouched and returns its id, so `caldav_apply` can
    report it. A server delete (`removed`) of a dirty row keeps the row,
    clears its href/etag (it becomes local-only), and reports it as a
    conflict.
  - Agent rows applied by `root_mcp_review` into a CalDAV calendar get the
    flag too, or step 6's staging makes them user-approved writes that take
    the same path. Check which.
- Tests: a principal href on another host gets no Basic auth and is refused;
  an `http:` href under an `https` origin is refused; an `http` base URL is
  refused at normalize, upsert and discovery; the merge keeps a dirty row
  and reports it; a failed push leaves the row dirty; a dirty row is pushed
  before the next fetch.
- Docs: `docs/context/caldav.md` (origin rule, http refusal, dirty rows).

**Agent step 8 (gap 20, B1/C3)**
- Removing `live_pwa` touches:
  - `mobile_control/mod.rs:19,37`;
  - `host.rs:51` (import), `:702` (`pdf_frame`) and `:6015`
    (`asset_response`), which go back to `MOBILE_ASSETS` only;
  - `build.rs:24-40` (`newest_mtime`, only used for
    `MOBILE_ASSETS_BUILT_AT`) and `:104-116` (`MOBILE_LIVE_DIR`, its
    rerun-if-env line). Drop both constants; grep shows no other user;
  - `package-dev.sh:42,51-100,157,226` (`publish_live_pwa`,
    `LIVE_PWA_DIR`, the env export);
  - `start-tabtivity-tauri-hotreload.sh:112-118`;
  - `backend-stale.sh:132-150` (the overlay comparison; `expected_entry`
    becomes `built_entry`);
  - `package-dev-auto.sh:218`;
  - the `dev_build.rs:546` log fixture line;
  - the comment at `commands/mobile_control.rs:316`;
  - the `filemap_backend.md` row, if one names `live_pwa`.

  `docs/filemap_rationale/` is frozen: leave it. A leftover
  `target/mobile-pwa/` is never read again, so nothing has to delete it.
- C3, queue: `dev_build::queue_if_behind` `dev_build.rs:380-410` stays.
  Document it in threat model row 20(b) and `dev_builds.md`: the window runs
  the checkout's `package-dev-auto.sh` unfenced whenever HEAD moves, so an
  agent's commit runs on the host at the next build. That is accepted.
- C3, launcher (`start-tabtivity-dev-build.sh:94-135`):
  - `package-dev.sh` already writes `<bin>.frozen` with the sha256 beside
    the artifact (`:234-241`). Add the sha256 to a list in the state dir
    (e.g. `<app_dir>/dev-builds/verified`, one sha per line, last 20 kept).
    Write it only when not under `AGENT_FENCE` and `$APP_DIR` is not a
    tmpfs (the check at `:260`). Inside a fence `$HOME` is the agent home,
    so a write there never reaches the real list.
  - The launcher adopts `target/release/<bin>` only when its sha256 is in
    that list. Remove the `assert-embedded-frontend.sh` fallback (`:105`),
    which would otherwise adopt an unlisted artifact.
  - Check `agent_fence`'s bind list: no fence may bind `<app_dir>/dev-builds`
    or a parent read-write.
  - Notify why when the hash is unknown.
- Docs: `dev_builds.md` (the live-PWA paragraph at `:39-48` goes, adoption
  at `:94-102` rewritten), `mobile_access.md` if it mentions the overlay,
  and AGENTS.md's "`npm run mobile:bundle` rebuilds it" stays true. See
  blocking question 1 for what the launcher hash does not cover.
- Tests: `dev_build` parse tests still pass without the publish line; a
  shell-level check is optional. Run `npm run mobile:bundle` and
  `npm run build`. The phone must still load from the binary (click-through
  step).

**All steps:** mark each fixed row in `docs/threat_model.md` "**Fixed, not
live-verified.**". Run `npm run backend:stale` after backend edits and
report it. New UI gets an `UntestedTag` + register row; every new string
goes through `useT()`. No step adds a Tauri command (step 1 reuses
`git_push_mcp_decide`, step 4 adds an argument), so `command_class` and
`commandClasses.ts` stay as they are. If an implementer adds one anyway, it
needs the `cfg_attr`, a class row and the regenerated file. Steps 2 and 4
change `cfg(windows)`/path code: run the Windows cross-check.

#### Blocking questions

1. **C3 launcher hash (step 8): it covers less than it seems.** The desktop
   entry runs `start-tabtivity-dev-build.sh` from the checkout
   (`package-dev.sh:40`, `Exec=$LAUNCHER`). That launcher sources
   `scripts/lib/brand.sh` and runs `scripts/retain-dev-build.sh` from the
   checkout too. An agent can edit any of them, even without committing,
   and the user's next click runs the edit unfenced, whatever the hash
   says. The hash only stops a binary dropped into `target/release/` while
   the launcher itself is untouched. Proposal: implement the hash as
   decided (step 8 goes ahead) and document this limit in row 20. Also ask
   the user whether `package-dev.sh`, when it runs unfenced, should install
   a copy of the launcher and its helpers into `<app_dir>/dev-launcher/`
   and point the desktop entry there. Then an uncommitted edit no longer
   runs at the next click; a committed one still runs through the queued
   build (C3).

No other blocking questions.

## Decisions for the user

- **A1 (step 1) — decided 2026-10-08: per-scope.** per-scope logins for every env- or config-shaped file (a login is entered once per scope), or keep sharing behind a per-CLI content validator. Reviewer's recommendation: per-scope for the dotenv files and Cline.
- **A2 (step 4) — decided 2026-10-12: only the confirmed repo.** CI reads only the repo confirmed for pushes, or one allowed once on an "Allow CI for <repo>" card; anything else answers `ci_repo_unconfirmed`.
- **B1/C3 (step 12) — decided 2026-10-12:** (B1) drop the no-relaunch phone update: remove `live_pwa`, the phone app always comes from the binary. (C3) keep auto-queueing dev builds from the window and document the residual in the threat model (the next dev build runs agent-written code anyway). The launcher verifies what it adopts: the unfenced build writes the binary's hash into the state dir, and the launcher adopts only a matching `target/release/<bin>`.
- **C2 (step 11) — decided 2026-10-12: confirm all, refuse launchers.** Every no-viewer hand-off to the OS asks first, naming the file; launcher types (`.desktop`, `.exe`, `.jar`, `.lnk`, `.cmd`, `.vbs`, …) and executable-bit files are refused outright. Same for Reader change cards.
- **D1 (step 5) — decided 2026-10-12: refuse every symlinked leaf** on viewer writes, in-root links included.
- **D3 (step 7) — decided 2026-10-12: keep the automatic re-raster**, writing only `.png` files inside the deck's own figure folder; absolute and `..` paths refused.
- **D6 (step 11) — decided 2026-10-12: yes**, add the app-wide navigation gate on `main`/`detached-*`/`present-*`.
- **E3 (step 9) — decided 2026-10-12: redact URLs and mark external** for mail-derived cards and events served to a cloud root tab (title and notes stay). Related, also decided: agent writes to a CalDAV-synced calendar always stage for approval, whatever the level.
- **E2b (step 10) — decided 2026-10-12: refuse `http://` CalDAV entirely**, accounts added as http included (they need a clear message saying why).

## Not reviewed

Reviewer F's whole area is open. Its write-up was stopped; these candidates
were never examined: OSC 8 link spoofing; PTY output forging the Focus
parsers' states; other loopback services in the shared network namespace
(Ollama, the user's dev servers); `core.excludesFile` pointing at a FIFO;
processes left detached inside a fence; approval-card races; phone IndexedDB
after revoke; crash reports and logs; clock changes against limits and
expiry; agent-written `.tabtivity` marker files; `tabtivity-send`; inotify
exhaustion; the hosted and headless trust boundaries. F confirmed as handled:
OSC 52 (focused pane only, read-back refused, `TerminalView.tsx:995-1006`),
the tmux socket (hidden by the fence), per-scope hook records, encrypted Web
Push, compiled-in verified-CLI versions, counts-only `usage_recap`, bidi
stripping on push cards and mail drafts, Vite 5.4.21.

Gaps in the other reviews:
- **A:** macOS Seatbelt and Windows paths; container mounts; `api_proxy`/`api_meter` internals beyond the regression check; schedule and help MCP internals; `exec_trust` fingerprinting; `home_io`/`agent_global` merge internals (spot-checked only).
- **B:** Tailscale Serve/Funnel drift check; the headless launch assembly; scheduler typing path; markup parsers; the desktop bridge for sidecar requests; `git_peer` in depth and `local_loss` completeness; VM projects. Unowned lead: `agent_session.rs:403-410` reads transcripts through symlinks, so a fenced agent may point its transcript at another scope's.
- **C:** the 715 commands not graded one by one (any script in the app origin is full compromise, as the threat model says); popout/present URL handling; `default_apps.rs`/`ide.rs`; boxes and brand-migration adoption; keychain call sites; `scripts/` and `.githooks/` beyond the dev build; `src-tauri/patches`; dependency pinning.
- **D:** `highlight.ts` and the compare/merge views (escape helpers spot-checked); `pdf_markup`/`pdf_clip`; `PdfViewer.tsx` beyond saves, links and loader; CSV size handling; `browser_engine::fetch_document_image` SSRF rules; WebKitGTK `about:srcdoc` CSP inheritance.
- **E:** PGP/S-MIME internals; the IMAP sync loop and filters; the review panel's rendering; ICS subscribe hops; `ics.ts`/`icsSafety.ts`; the `mail_reader` VM lane; schedule MCP delivery.
