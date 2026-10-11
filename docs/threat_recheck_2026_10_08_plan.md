# Threat-model recheck 2026-10-08 — findings and fix plan

Status: **partly done.** Plan steps 1, 2, 3, 6, 8, 13 and 14 are fixed in
develop (`bdafdf03`, 2026-10-09; not pushed, not live-verified). The rest is
listed under "Resume state" below.

## Resume state (2026-10-10)

"Continue the threat recheck" means: take the next item below whose decision
is answered, run it with the plan → implement → review routine (handoff:
`docs/threat_recheck_2026_10_08_handoff.md`, append new sections there), mark
its rows in `docs/threat_model.md`, then land on develop. Ask the user only
the decision an item names.

1. **Steps waiting on a decision** (see "Decisions for the user"):

   | Plan step | Gaps | Decision |
   |---|---|---|
   | 4 | 19 | A2 |
   | 5 | 22, 31 | D1 |
   | 7 | 23 (after step 5) | D3 |
   | 9 | 25, 27, 33, 34 | E3 |
   | 10 | 26, 32 | E2b |
   | 11 | 21, 38 | C2, D6 |
   | 12 | 20 | B1/C3 |

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

## Decisions for the user

- **A1 (step 1) — decided 2026-10-08: per-scope.** per-scope logins for every env- or config-shaped file (a login is entered once per scope), or keep sharing behind a per-CLI content validator. Reviewer's recommendation: per-scope for the dotenv files and Cline.
- **A2 (step 4):** gate CI reads on the confirmed push URL (CI then needs one confirmed push or a one-time "allow CI for <repo>" card), or let CI read public repos without the token until confirmed.
- **B1/C3 (step 12):** keep the no-relaunch phone update behind an unfenced adoption step, or drop it. Keep auto-queueing dev builds from the window, or require a click. Should the launcher verify the artifact it adopts?
- **C2 (step 11):** confirm before handing any no-viewer file to the OS, or refuse launcher types outright.
- **D1 (step 5):** refuse every symlinked leaf on viewer writes (simplest, matches the drop-box rule), or follow in-root links by handle.
- **D3 (step 7):** keep the deck's automatic re-raster, limited to its own figure folder, or make it click-only.
- **D6 (step 11):** add an app-wide navigation gate on `main`/`detached-*`/`present-*` that refuses anything off the app origin.
- **E3 (step 9):** mail-derived cards and events for a cloud root tab: redact URLs and mark them, or withhold title and notes entirely. Related: synced CalDAV invitation rows reach a cloud root agent unredacted today; and at the `destructive` level an agent's calendar write is pushed to a CalDAV server without a click. Should CalDAV-bound rows always stage?
- **E2b (step 10):** refuse `http://` CalDAV hrefs entirely, or only under an `https` account URL.

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
