# Simplify pass over the week of 2026-11-05 — what is still open

A quality review (reuse, simplification, efficiency, altitude) of the 356
commits since `5ec871f38` found 62 items. 49 were implemented on 2026-11-12
(uncommitted on `develop` at the time of writing; checked by type-check, lint,
Clippy and the touched modules' own tests, not by the full suites and not
live). This file keeps only what was left, with the reason. Verify against the
code before acting; nothing here is a known bug unless it says so.

## Deliberate behaviour changes made by the pass

Everything else was meant to be behaviour-identical.

- **Steering hook** (`src/hooks/useSteering.ts`): the effect is no longer
  rebuilt on every `AppShell` render, so steering's memory (the panel it
  opened, the field it lent the keys to) survives a render.
- **Copy code in the Reader** (`TerminalReaderView.tsx` `CopyCodeButton`):
  writes through `copy_text_to_clipboard` (`src/lib/terminal/copyText.ts`),
  falling back to `navigator.clipboard`.
- **TensorBoard live follow** (`TensorBoardView.tsx`): runs on `usePoll`; it
  pauses while the window is hidden and reads at a third of the rate while it
  is blurred or under Energy Saver.
- **Windows device names** (`paths::is_windows_device_name`): one check;
  `cockpit_results` now also refuses `COM0`/`LPT0`, and `sync_handoff::safe_rel`
  also refuses `CONIN$`, `CONOUT$`, `COM0`/`LPT0`, the superscript ports and
  names like `con .txt`.
- **Piper install script**: uses `shasum -a 256` on macOS, as the speech-model
  script does.
- **Sync side times**: the blame cache holds 6 entries, not 24.
- **Settings page step in steering**: `placeCursorSoon` checks that steering is
  still on that region before its first try as well as on each retry.
- **Voice landing on the phone**: the quiet-wait tears itself down when its
  tail fires, so a skip tapped in the same tick cannot start the mic twice.
- **Lane tokens at tab exit** (`terminal/mod.rs`): revoked in table order, and
  a spawn holding both the root and the schedule token has both handled.

## Owed checks

- The full suites (`scripts/gates-job.sh start`) and a live run.
- `commands/clipboard.rs` `set_clipboard`: the non-Linux branch compiles on
  Linux but has not been built for macOS or Windows.

## Still open

| Was # | Where | What | Why it was left |
|---|---|---|---|
| 6 | `commands/projects.rs` `copy_tree_core*` vs `services/tree_copy.rs` | A second hardened tree copier. | Not equivalent: it errors on an unreadable file where `tree_copy` skips it (a move deletes its source after `Ok`, so a swap risks data loss), copies non-UTF-8 names, follows a link on Windows, and replaces existing files on a resumed pass where `tree_copy` refuses them. Its limit machinery is pinned by tests. Needs a design, not a refactor. |
| 13 | `components/layout/SteeringPromptOverlay.tsx` | One `list` state for the commit and effort lists. | **Possible bug found:** `openEffort` and `openModel` leave `commitOpen` set, so both lists show and the keys keep going to the commit list. Decide the intended behaviour first; a single state would then be the fix. |
| 22 | `components/terminal/TerminalView.tsx` | `useTerminalServers` hook. | Not a pure move: the state sits mid hook list, the Ports effect 2,000 lines later, and the refs are read by the spawn effect and the link router. |
| 28 | `embed/SyncMergeView.tsx`, `lib/viewers/syncHandoffCollect.ts` | Use `localMirrorRootFor` / `resolvePath`. | A restored `syncmerge` tab of a project that has since become host-pinned or local would get "not a mirror file" instead of the default mirror path; `resolvePath` normalises and uses `\` under a Windows root. |
| 29 | `embed/DiffView.tsx` | Body keyed by path instead of path-tagged state. | A remount restarts `useDiffSource` (a loading blank on every file switch) and resets the scroll node. |
| 30 | `embed/fileViewer/TexView.tsx:1394`, `lib/viewers/tex/hostTexBuild.ts` | Ctrl+S "only saves on a host build". | The comment is stale since the host build became a background compile; whether Ctrl+S should compile there is the user's call. |
| 31 | `lib/viewers/print.ts:1018-1070` | Skip re-cloning paged copies when nothing changed. | Another session was editing the file. |
| 37 | `mobile-web/src/steering/usePhoneSteering.ts`, `NeedsYou.tsx`, `Activity.tsx` | `/api/v1/activity` fetched twice per tick. | Changes polling; no phone steering test covers the race. |
| 38 | `mobile-web/src/steering/usePhoneSteering.ts:163-190` | Body-wide `MutationObserver` scans the DOM every frame while a chat streams. | Changes what publishes; no test covers it. |
| 49 | `scripts/verify-cli/claude/*`, `stub_openai.py` | Shared hook-dump and trust-dialog helpers. | The copies differ (`"Yes"` vs `"folder"`, different hook events) and the scripts need the real CLIs to check. |
| 52 | `services/port_forward.rs` | One `ssh -O check` instead of two per forward. | `alive()` has a Windows answer and a test-only list that `master_pid` lacks; a merged call changes both, plus the `Mux` trait and its fake. |
| 54 | `services/run_heartbeat.rs` | Reuse `sysstat` parsers. | Done for threads only. The memory parsers answer 0 for a missing field where the heartbeat omits the reading; a missing reading must not show as zero. |
| 61 | `services/mcp/git_push_mcp.rs:413-452` | `git cat-file --batch` for the workflow files. | Changes the per-file cut and timeout rules of the release check; wants its own test first. |
| 16 | `components/terminal/TerminalView.tsx` | Four more `copy_text_to_clipboard` sites (OSC 52, link double-click, server chip, sign-in). | They have no fallback today; converting them to `copyText` would add one. |
| 15 | `TerminalView.tsx:789`, `TerminalReaderView.tsx:1498` | `onParsedSettled` for the last two settle timers. | Timing-sensitive. |
| 21 | repo-wide | `wrapStep` for the remaining `(at + delta + n) % n` sites. | Applied to the steering files only. |
| 23 | `components/settings/ClaudeTokenRow.tsx` | The In use / Standby label goes stale after a login import or sign-out. | Needs `AgentsPanel`'s `loginsVersion` passed to both copies. |
| 11 | `components/mail/MailView.tsx` | Inbox tab key handler. | Not the same contract as the view-bar tabs (no arrows, middle-click close). |
| — | `services/web_safety.rs` `RESERVED_NAMES` | A fourth Windows device-name list (mail attachments). | Outside the finding; could use `paths::is_windows_device_name`. |
| 47 | `commands/tex/host.rs:66,115` | `engine.filter(ENGINES.contains)`. | Kept on purpose: the value reaches a remote command line. |
