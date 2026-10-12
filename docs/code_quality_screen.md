# Code-quality screen — 2026-10-12

A read-only screen of the whole codebase for **duplicates**, **bad coding
practices** and **simplification candidates** (over-long files and functions,
verbose code). It is not about runtime performance. Four agents screened the
code in parallel, one area each. Nothing was edited, built or run. Line
numbers are from `develop` at the time of the screen, so check them against
the code before acting. Findings were checked against `docs/filemap_*` and
`docs/filemap_rationale/`, and deliberate patterns were left out (per-OS
`cfg` twins, mount-only effects, best-effort cleanup).

| Area | Scope | Findings |
|---|---|---:|
| [Frontend — components](#frontend--components-srccomponents) | `src/components/` (157k lines) | 33 |
| [Frontend — lib, stores, hooks, phone PWA](#frontend--lib-stores-hooks-phone-pwa) | `src/lib`, `src/stores`, `src/hooks`, `mobile-web/src` (169k) | 34 |
| [Backend — services](#backend--services-src-taurisrcservices) | `src-tauri/src/services/` (180k) | 31 |
| [Backend — commands, app shell, server crates](#backend-commands-app-shell-server-crates) | `src-tauri/src/commands/`, the rest of `src-tauri/src`, `src-core`, `src-gateway`, `src-serverd` | 33 |

Severity: **High / Med / Low** rates the payoff, meaning lines saved or bug
risk removed.

## Fix these first

These are the items where a duplicate or inconsistency is already a defect,
not just extra lines.

**Status (2026-10-12): all eight are fixed on `develop`, in the commit that
added this doc. None has been run live.** What changed:

- **1 — SFTP:** every spawn in `services/sftp.rs` goes through
  `paths::command_no_window`. The dead `download`/`download_on` are deleted.
- **2 — Private files:** there is one shared writer,
  `storage::write_private_atomic` (`_mode` and `create_private_atomic`
  variants). Each write goes to a unique temp file that is owner-only from
  the start, then fsync, rename, and a directory fsync. All of these use it:
  - the mail key
  - the web login token (the first mint uses `create_private_atomic`; a
    concurrent minter adopts the winner)
  - the stored `.ovpn` file and the askpass/userpass/management files
  - the pairing key
  - the phone store

  The duplicate `write_bytes_durable` and both mail `harden` copies are
  merged into one. *Open:* mail_store's per-blob `harden` now really runs on
  Windows. That is two `icacls` spawns per blob; the old version was
  deliberately a no-op there, relying on the profile ACL. Decide whether to
  keep it, or to give the `blobs/` and `outbox/` folders an inheritable ACL
  instead.
- **3 — Mail migrations:** `add_column_if_missing` and `column_exists` now
  report real errors.
- **4 — Project folder lookup:** one `ProjectEntry::directory()` in
  `schema/projects.rs`, with the same rule as the frontend's
  `resolveProjectDirectory`, but it never returns a filesystem root. The
  `projects`, `agent_fence`, `remote`, `fs`, `boxes`, `sandbox`, `root_mcp`
  and `git_publish` copies are now wrappers around it.
- **5 — Markdown TOC:** one `slugify`, and the renderer gives repeated heading
  ids `-n` suffixes. `generateToc` reads the renderer's own heading pass.
  Related fix: `# C#` keeps its `#`.
- **6 — Timer:** `elapsedToday` and `flushRunning` are shared by `toggle`,
  `setProject` and `flush`.
- **7 — Leaks:**
  - New `hooks/useTauriListener.ts` (`subscribeTauri`); the leaking and
    uncaught sites use it.
  - `listenDetachedHost` disposes everything on a partial failure.
  - `git_ci::admit_rate` prunes idle tabs.
  - Random ids no longer fall back to zeros: request ids come from
    `new_request_id`, and an empty id is refused before it reaches the
    desktop.
- **8 — Sign-in URLs:** there is one `isSignInUrl` in `terminalUrls.ts`, which
  the phone imports. A bare `client_id` no longer counts.

Original findings:

1. **`sftp.rs` resolves `ssh` from user-writable dirs.** It uses a bare
   `Command::new("ssh")` instead of `paths::command_no_window`, which bypasses
   the #861 trusted-helper hardening for background SFTP
   (`services/sftp.rs:205/264/276`).
2. **Owner-only files written non-atomically or world-readable for a moment:**
   - the mail key file (`mail_crypt.rs:635`): written with the umask, chmodded
     to 0600 afterwards, never fsynced
   - the web login token (`web_client.rs:367`): rewritten in place, so a
     racing reader mints a second token
   - `.ovpn` copies (`openvpn.rs:361`)

   Ten separate atomic-write helpers exist (see Backend — services).
3. **Mail schema migration ignores every error.** In `mail_store.rs:638–816`,
   `let _ = ALTER TABLE …` throws away real failures such as a locked
   database or a full disk.
4. **Project directory lookup is written four times with different rules.**
   The `agent_fence` copy falls back with `strip_suffix("/project.json")`,
   which never matches a Windows path (`services/agent_fence.rs:252`).
5. **Markdown TOC links go nowhere:**
   - The two `slugify` functions apply their steps in a different order.
   - The renderer never gives repeated headings distinct ids.

   (`lib/viewers/markdownEdit.ts:129` vs `markdown.ts:120`)
6. **Timer books yesterday's time into today.** `stores/timer.ts` `toggle` and
   `setProject` skip the midnight clamp that `flush` applies.
7. **Unbounded map and leaks:**
   - `git_ci::admit_rate` never prunes idle tabs.
   - Tauri listeners leak when a component unmounts before `listen` resolves
     (AppShell, DetachedApp).
   - `listenDetachedHost` leaks the listeners it already registered if a later
     `listen` fails.
   - `random_16` / `random_rule_id` produce all-zero ids when `getrandom`
     fails.
8. **Phone and desktop decide differently whether a URL is a sign-in link**
   (`terminalUrls.ts:89` vs `mobile-web/src/terminal/signIn.ts:95`).

## Cross-cutting themes

Several areas found the same pattern independently. One shared helper per
theme removes the most code:

- **Blocking-call boilerplate:** 12 `run_off_thread` copies and about 284
  inline `spawn_blocking(..).await.map_err(..)` sites on three runtimes. Fix:
  `app_core::rt::blocking(label, f)`, saving about 600 lines.
- **String errors:** 431 `.map_err(|e| e.to_string())` in commands and 210 in
  `mail_store.rs`, and "project not found" is phrased four ways. Fix: a
  `CmdError` that serializes as a plain string, so the wire format is
  unchanged.
- **Mutex poisoning handled three ways:** about 240 bare `lock().unwrap()`
  across `services/`, `commands/`, `terminal/` and `lib.rs`. A panic under the
  openvpn, window or PTY registry lock turns every later call, exit teardown
  included, into a panic. Fix: one poison-recovering `lock_ok()`.
- **Layering:** `services/` reaches into `crate::commands::` 196 times
  (`calendar::read_data`, `projects::uuid_v4`, the hardened git builders).
  Fix: move them down into `services::{project_registry, calendar_store,
  git_cmd}`.
- **Small helpers written many times over:**
  - `now_secs`/`now_ms`: 12+ copies
  - hand-rolled date math, although `chrono` is already a dependency
  - sha256/hex
  - POSIX and PowerShell quoting: about 7 copies across `services/` and
    `commands/`
  - `YYYY-MM-DD`: 8 copies, desktop and phone
  - byte labels: 6
  - path `extname`: 9
  - HTML escaping: 5
  - `formatTime`: 5
  - `projects.json`/`settings.json` paths spelled out by hand about 70 times
- **Frontend mechanisms copied 3–35 times:**
  - Tauri subscribe/unsubscribe blocks (Fix: `useTauriListener`)
  - the split-divider drag
  - the tab chip and its state class
  - the file-mtime reload poll (only one copy respects power-saver mode)
  - the VPN/SSH login flow
  - the cross-window event stores
- **Dialogs and i18n:**
  - About 61 hand-rolled modals skip `useModalFocus`, so global shortcuts stay
    live, with no focus trap and no proper Escape.
  - About 209 sentences are glued together from i18n fragments, which
    translators cannot reorder.
  - About 90 dead i18n keys × 5 dictionaries are left over from the old
    Agents view.
- **Giant units to split along their existing section headers:**

  | Unit | Lines |
  |---|---:|
  | `FileViewerPane.tsx` | 10.9k (`CodeEditor` alone 2,765) |
  | `mobile_control/host.rs` | 6.6k |
  | `stores/tabs.ts` | 6.6k |
  | `commands/projects.rs` | 5.0k |
  | `commands/ollama.rs` | 4.7k |
  | `FileTree` | 4.5k |
  | phone `Terminal` | 3.7k (97 `useState`) |
  | `PdfCanvas` | 3.6k |
  | `lib.rs` `run()` | 1,382 |
  | `launch_prep::prepare` | 578 |

---

## Frontend — components (`src/components/`)

Scope: 378 non-test TS/TSX files, 157,269 lines. Read-only screen; nothing was edited or run.
Baseline hygiene is good: no `any`, no `@ts-ignore`, no non-deps `eslint-disable`, only 3 `as unknown as`.
Most findings are about **parallel copies**: two or three hand-maintained versions of the same mechanism, kept in step by comments like "mirrors X" or "parity with Y".

### Size hotspots (table)

| File | Lines | Longest top-level function (lines) | Hooks inside it |
|---|---:|---|---|
| `embed/FileViewerPane.tsx` | 10,872 | `CodeEditor` @2881 (2,765); `TexView` @9333 (1,216) | CodeEditor: 33 props, 33 `useEffect`, 28 `useState`, 44 `useRef` |
| `embed/pdf/PdfViewer.tsx` | 5,538 | `PdfCanvas` @1897 (3,583); `PdfPageCanvas` @588 (1,039) | PdfCanvas: 45 effects, 68 state, 46 refs, 61 callbacks |
| `files/FileTree.tsx` | 5,147 | `FileTree` @650 (4,498) | 22 effects, 45 state, 20 refs |
| `layout/SettingsSubPanels.tsx` | 4,194 | `OllamaPanel` @2880 (1,315); `AgentsPanel` @1982 (871) | — |
| `projects/ProjectPill.tsx` | 2,928 | `ProjectPill` @1420 (1,509) + 13 portal dialogs | — |
| `files/ProjectFilesView.tsx` | 2,840 | `ProjectFilesView` @360 (2,481) | 16 effects, 32 state |
| `mobile/MobileBridgeHost.tsx` | 2,614 | mostly module-level non-React functions | 3 hooks in the whole file |
| `header/MachinesIndicator.tsx` | 2,573 | `MachinesSurface` @261 (2,313) | 45 state |
| `tabs/TabBar.tsx` | 2,333 | `TabBar` @469 (1,865) | — |
| `terminal/TerminalView.tsx` | 2,331 | `TerminalView` @267 (2,065) | — |
| `layout/DetachedCenterPanel.tsx` | 2,162 | `DetachedCenterPanel` @204 (1,959) | — |
| `layout/AppShell.tsx` | 1,576 | `AppShell` @359 (1,218) | 39 `useEffect` |

### Duplicates

- **[High]** `layout/AppShell.tsx:680-776`, `layout/DetachedApp.tsx:318-405`, `embed/pdf/PdfPresentApp.tsx:130-205`, `embed/deck/DeckAudienceApp.tsx:87-180`, `embed/deck/DeckPresenter.tsx`, `layout/DetachedCenterPanel.tsx`: the Tauri subscribe/unsubscribe block (`let unlisten; let cancelled=false; listenX().then(fn => cancelled ? fn() : unlisten = fn).catch(()=>{}); return () => {cancelled=true; unlisten?.()}`) is written out about 35 times, 9 of them in AppShell and 10 in DetachedApp. The copies have already drifted. Some have no `.catch`, which leaves unhandled rejections (PdfPresentApp `:170-180,190`, DeckAudienceApp `:121-130,161`). Others push into an array with no dispose check, so a listener leaks if the component unmounts before `listen` resolves (AppShell `:482-483,508-509`, DetachedApp `:436-437`). *Fix:* add a `useTauriListener(subscribe: () => Promise<UnlistenFn>, deps)` hook in `src/hooks/` that handles the cancel and dispose race and the catch in one place. That removes about 350 lines.
- **[High]** `layout/AppShell.tsx:464-489` and `layout/DetachedApp.tsx:418-443`: the bridge from Tauri `onResized`/`onScaleChanged` to the DOM `resize` event (rAF-coalesced, 250 ms trailing re-fire) is copied verbatim, and the comment says so. The cross-window listeners for `listenPdfReveal`, `listenEditorJump` and `listenTexCenter` are also registered in both files. *Fix:* add `useWindowResizeBridge()` and `useCrossWindowViewerListeners()` hooks and mount them from both shells.
- **[High]** `layout/CenterPanel.tsx:1646` (`SplitView`), `layout/RootOverlay.tsx:1080` (`OverlaySplit`) and `layout/DetachedCenterPanel.tsx:537` (`onDividerPointerDown`) are three implementations of the split-divider drag. They differ in ways that look accidental. RootOverlay has no `setPointerCapture`, no teardown on unmount (window listeners leak if the console closes mid-drag), and no re-applying of drag sizes after a re-render. DetachedCenterPanel calls `getBoundingClientRect()` on every pointermove. *Fix:* one `useSplitDividerDrag({node, minW, minH, onCommit, onLive, onResized})` hook, or one shared `<SplitContainer>`. Every caller already uses the same `dividerFraction` and `bindDragRelease`.
- **[High]** `tabs/TabBar.tsx:184` (`tabStateClassOf`, private), `layout/RootOverlay.tsx:991-999` (`GroupStrip`) and `layout/DetachedCenterPanel.tsx:1491-1503` (`stateOf`): the working/attention → state-class rule is copied three times. The popout strip also re-implements TabBar's tab chip inline ("this strip is bespoke … parity with the main-window TabBar"). That includes recomputing the schedule indicator for each tab on every render in an IIFE (`DetachedCenterPanel.tsx:1590-1606`), which duplicates `TabBar.tsx:388-399`. *Fix:* export `tabStateClassOf` from `tabs/`. Then extract the chip body (status mark, label, badges, schedule indicator, close button) into a `TabChipContent` used by all three strips.
- **[High]** `embed/FileViewerPane.tsx:1613, 2155-2171, 8616`, `embed/GifView.tsx:110-128`, `embed/OdtView.tsx:71-85`, `embed/pdf/PdfPresentApp.tsx:329`, `embed/pdf/PdfViewer.tsx:3975-4000`: the "poll `fileMtime` every `RELOAD_POLL_MS`, act when it advances" effect exists 7 times, and `RELOAD_POLL_MS = 1500` is declared 5 times. Only one copy (`FileViewerPane.tsx:1613`) respects `saverInterval(…, quiesce)`. The other six ignore power-saver mode. *Fix:* add `useFileChangeWatch(path, scope, onAdvance, {enabled, seedMtime})` built on `usePoll` (`lib/usePoll.ts`), which already handles pane visibility and quiesce.
- **[High]** `projects/useRemoteSession.ts` and `projects/useRemoteReconnect.ts` (about 890 lines each) repeat the same login plumbing:
  - `VPN_READY_MARKER` at `:30` and `:33`
  - `browseVpnConfig` at `:437` and `:383`, plus a third copy at `header/VpnIndicator.tsx:457`
  - `startVpnTerm` at `:513` and `:478`
  - `startSshTerm` at `:655` and `:594`
  - the terminal-output watcher for the ready marker at `:540-560` and `:440-470`
  - the term-id minting helpers at `:55` and `:46`

  The hooks differ only in where state lands (component state vs. per-project stores). *Fix:* extract `pickOpenVpnConfig()`, `openVpnLoginTerm(config)`, `openSshLoginTerm(conn)` and `useVpnReadyWatch(termId, onReady)` into `lib/remote/` or `projects/remoteLogin.ts`, and have both hooks call them.
- **[Med]** `projects/ProjectPill.tsx:723, 798, 863, 930, 1187` (`DisableGitWindow`, `ArchiveConfirmWindow`, `ForgetConfirmWindow`, `DetachRemoteWindow`, `UnpublishWindow`): five copies of the same busy/error confirm dialog. Each has its own `run()`, portal, backdrop, title row and actions, and the `ForgetConfirmWindow` doc comment says "Same shape as ArchiveConfirmWindow". *Fix:* one `AsyncConfirmDialog({title, body, confirmLabel, busyLabel, danger, onConfirm})` built on `common/PromptDialogs.tsx` `DialogShell`. That saves about 250 lines and fixes the next item for these five.
- **[Med]** `embed/pdf/PdfPresentApp.tsx:122-205` and `embed/deck/DeckAudienceApp.tsx:83-180` repeat the presenter window setup: `loadSettings({skipZoom})`, the theme listener, fullscreen tracking via `onResized`, and the seed handshake with `READY_RETRY_MS = 400` declared in both (`:49` and `:58`). DeckPresenter repeats the `presenter_inhibit_sleep` pair. *Fix:* `usePresenterWindowChrome()` plus `useSeedHandshake(readyEvent, seedEvent, label)` in `embed/present/`.
- **[Med]** `formatTime(secs)` exists 5 times:
  - `projects/ProjectHoverCard.tsx:26`
  - `header/AppTimerDisplay.tsx:9`, identical to the one above and using its i18n key
  - `projects/ActivityCalendar.tsx:10`
  - `stats/StatsRecap.tsx:39`, hardcoded `"< 1m"`
  - `common/ProjectBlobPane.tsx:107` (`fmtWorked`), hardcoded English

  *Fix:* one `formatWorkedDuration(t, secs, {zero})` in `lib/` (next to `lib/formatBytes.ts`, the same consolidation story), and import the exported `ProjectHoverCard.formatTime` where it is identical.
- **[Med]** Path helpers re-implemented beside `lib/paths.ts`. `files/GitPullPanel.tsx:28-38` has `joinPath`/`dirOf`/`baseOf`; they are `/`-only, so a Windows repo dir gives `C:\x/rel` and `dirOf` misbehaves. `files/GitHistory.tsx:143` has its own `basename`. `projects/ProjectPill.tsx:1705` defines an inline `parentOf`, which is `lib/paths` `dirname`. `extOf`/`extensionOf` exists in `embed/MediaView.tsx:47`, `embed/tex/TexStructureSidebar.tsx:123` and `files/FileTreeSearch.tsx:43`, plus three copies in `lib/viewers/*` (cross-scope). *Fix:* use `lib/paths` `basename`/`dirname`/`resolvePath`, and add one `extname(path, {dot})` there.
- **[Low]** `mobile/MobileBridgeHost.tsx:573` (`isAgentKind`), `lib/agents/agentWorktrees.ts:108` (`isAgentMenuKind`), and 37 inline `kind === "agent" || kind === "local_agent"` checks in 23 files. *Fix:* export `isAgentKind(kind)` from `stores/tabs.ts`, next to `isLocalAgentKind`.
- **[Low]** `terminal/TerminalView.tsx:228-244` and `embed/FileViewerPane.tsx:6599-6604`: the 8–32 font-size clamp is duplicated, and 71 inline `Math.min(…Math.max(…))` clamps exist across components with no shared `clamp`. *Fix:* add `clamp(n, lo, hi)` to `lib/`, and share `FONT_MIN`/`FONT_MAX`.
- **[Low]** `monitoring/SystemMonitorPane.tsx:191` (`formatKib`): another byte ladder. It is not in the list of deliberate variants in `lib/formatBytes.ts`. *Fix:* use `lib/projects/diskUsage` compact `formatBytes(kib*1024)`, or add it to that list.

### Bad practices

- **[High]** About 61 files open a hand-rolled modal (`.modal-backdrop` portal) without `useModalFocus` or `DialogShell`. ProjectPill alone has 13 backdrops; others include `projects/BoxEditorDialog.tsx:112` and `files/SendToProjectDialog.tsx:85` (a document-level Escape listener). The modal stack is the only thing `hooks/useKeyboard.ts:838,1031` checks (`hasActiveModal()`). So for these dialogs, global workspace chords stay live while the dialog is open, and there is no focus trap or focus restore. Escape is either missing (ProjectPill's confirm windows) or not topmost-only. *Fix:* migrate them to `DialogShell`, or at least attach `useModalFocus(onClose)` to the frame. ProjectPill's five confirm windows (above) are the cheapest place to start.
- **[Med]** 53 raw `<div className="settings-title-row">` headers are built by hand, while `layout/settingsUi.tsx:31` `SettingsHeader` exists for exactly this. 52 of the 55 `dialog-close-btn` buttons have no `aria-label` or `title` (for example `layout/LessonsMenu.tsx:39`, `projects/RemoteConnectDialog.tsx:320`, `header/AppTimerDisplay.tsx:34`, which also lacks `type="button"`). *Fix:* use `SettingsHeader`, or a `DialogCloseButton` that always carries `aria-label={t("common.close")}`.
- **[Med]** About 209 sentences are built by concatenating `…Pre`/`…Mid`/`…Post`/`…Desc1-4` fragments. ProjectPill has 19 and SettingsSubPanels 19; `projects/ProjectPill.tsx:829, 896, 1218` are examples. Translators cannot reorder the words, which breaks any language with different word order. *Fix:* add a small rich-text helper to `lib/i18n.ts` (for example `tRich(key, {name: <strong/>})` with `{name}` placeholders) and fold the fragment groups into whole sentences.
- **[Med]** Hardcoded user-facing English bypasses `useT()`:
  - `common/ProjectBlobPane.tsx:107-111` (`"untracked"`, `"… worked"`), plus `:991`, which shows the raw `project.status` enum, although `ProjectHoverCard.statusLabel` exists
  - `stats/StatsRecap.tsx:40` (`"< 1m"`, `"0m"`)
  - `projects/HpcPipelineWizard.tsx:295,322` (`setError(\`Project created, but …\`)`)
  - `monitoring/SystemMonitorPane.tsx:425` (`label="Util"`)
  - OS file-picker filter names: `"OpenVPN config"` three times (`useRemoteSession.ts:440`, `useRemoteReconnect.ts:386`, `VpnIndicator.tsx:457`) and `"Image"` at `embed/deck/DeckView.tsx:1049`

  *Fix:* add keys and route these through `t()`.
- **[Med]** `projects/ProjectPill.tsx:1712, 1728`: a failed remote-mirror **move** (`moveRemoteMirror`, which relocates the user's bytes) and a failed "show on disk" (`:1689`) only reach `console.error`, so the user sees nothing. The sibling `IdeMenuItems.tsx:69-72` shows the right pattern (`switchToast`). *Fix:* surface the error with `switchToast` or an `ErrorNote`, as IdeMenuItems does.
- **[Low]** Dead exports with no reference anywhere in `src/` or `mobile-web/`:
  - `projects/PillStatusBars.tsx:13` `statusBarKinds`
  - `embed/fileAccess.ts:190` `detectMime`. Cross-scope: the backend command `detect_mime` (`src-tauri/src/commands/fs.rs:1436`) then has no frontend caller.
  - `embed/deck/FontField.tsx:47` `resetFontList`, documented "Tests only" but no test uses it
  - `embed/deck/FontField.tsx:131` `BUILT_IN_FAMILIES`

  *Fix:* delete them. Separately, about 150 exports in components are referenced only inside their own file (mostly `*Props` interfaces). That is harmless, but `export` could be dropped.
- **[Low]** `embed/FileViewerPane.tsx:405` (`pathToFileUri` = `toFileUri`) and `:1782` (`escapeHtmlText = escapeHtml`) are pass-through aliases. `embed/NotebookView.tsx:6` imports `escapeHtmlText` from the 10k-line viewer module, and `lib/viewers/odt.ts:25` keeps its own `esc` "mirroring" it (cross-scope). *Fix:* import `toFileUri`/`escapeHtml` from `lib/` directly and delete the aliases.
- **[Low]** 254 `.catch(() => {})` in components: AppShell 27, DetachedApp 19, AgentScheduleHost 14, FileViewerPane 13, TerminalView 12. Most are best-effort and fine, but they make the deliberate ones indistinguishable. *Fix:* most disappear with `useTauriListener`. For the rest, add an `ignoreError(reason)` helper or a one-word comment so a swallow is visibly intentional.
- **[Low]** `embed/deck/DeckPresenter.tsx:234` and `embed/pdf/PdfPresentApp.tsx:149` pass English `reason` strings ("Presenting a deck/PDF") to `presenter_inhibit_sleep`, which desktop environments show in their inhibitor list. *Fix:* use `t()`, or a brand-neutral constant.

### Simplification candidates

- **[High]** `embed/FileViewerPane.tsx` (10,872 lines). `CodeEditor` (`:2881-5650`) is one 2,765-line component with 33 props, 33 effects, 28 state and 44 refs. The file also holds about 1,000 lines of pure string and decoration functions (`:1651-2690`: indent, brackets, search, grammar and change ranges), the SyncTeX jump router (`:1042-1218`), and full viewers (`TexView` 1,216 lines, `TexWorkspaceView`, `MarkdownView`, `TextView`, `ImageView`). *Fix:* move the pure helpers to `lib/viewers/editor/*.ts` (they are already unit-tested by export), the source-jump routing to `lib/viewers/tex/sourceJump.ts`, and each viewer to its own file. Split `CodeEditor` into hooks: autocomplete ghost, spell/grammar, hover preview, caret/goto, font/wheel.
- **[High]** `files/FileTree.tsx:650` is a 4,498-line component with 45 `useState`. Seven independent dialog states (`deleteConfirm`, `autoConfirm`, `defaultAppFor`, `sendTo`, `remarkFor`, `pastePrompt`, `renamePrompt`, `:923-932`) can only be open one at a time. *Fix:* replace them with one `dialog` discriminated union. Extract the search state (`:851-879`) into `useTreeSearch()`, and the git, size and tex-capability fetches into data hooks.
- **[High]** `embed/pdf/PdfViewer.tsx:1897` `PdfCanvas` is 3,583 lines with 68 state, 46 refs and 61 callbacks. *Fix:* split along the existing feature seams (markup is already `usePdfMarkup`; also search, page edits, present, SyncTeX reveal) into hooks or sub-components, the way `usePdfMarkup.ts` was done.
- **[Med]** `mobile/MobileBridgeHost.tsx` (2,614 lines) is almost entirely module-level non-React logic (`agentStatuses`, `create`, `renameAgentTab`, `reorderMobileTab`, …), with 3 hooks in the whole file. *Fix:* move it to `lib/mobile/bridge/*.ts`, keep a thin host component, and the logic becomes testable without React.
- **[Med]** Settings are split arbitrarily between `layout/SettingsPanel.tsx` (11 sub-panels) and `layout/SettingsSubPanels.tsx` (`OllamaPanel` 1,315 lines, `AgentsPanel` 871). *Fix:* use a `layout/settings/` folder with one file per panel.
- **[Med]** `layout/AppShell.tsx` has 39 `useEffect` in one component, many of them unrelated one-shot subscriptions. *Fix:* after `useTauriListener` and the shared window hooks above, group the rest into named hooks (`useAppCloseTeardown` `:776-840`, `useWindowGeometryPersist` `:496-514`). That should cut the component by about 400 lines.
- **[Med]** `header/MachinesIndicator.tsx:261` `MachinesSurface` is 2,313 lines with 45 `useState`. *Fix:* split it per section (rows, utilisation, probes, dialogs) and fold the related flags into reducers.
- **[Low]** `projects/ProjectPill.tsx` holds 13 dialog components (`:106-1420`) ahead of the pill itself. *Fix:* move them to `projects/pillDialogs/`, after collapsing the five confirm windows into `AsyncConfirmDialog`.


## Frontend — lib, stores, hooks, phone PWA

Scope: `src/lib/`, `src/stores/`, `src/hooks/`, `src/{types,dev,web}` + top-level `src/*.ts(x)`, `mobile-web/src/`, about 169k non-test lines (about 48k of them i18n dictionaries). This was a read-only review. Every finding below was checked against the source. Function lengths come from a brace-matching scan, so treat them as close to exact rather than exact.

Scan results that came back clean: no `any` / `as any` anywhere in scope. No hardcoded user-facing strings outside `src/dev/` (which never ships).

### Size hotspots (table)

| File | Lines | Longest function in it (lines) |
|---|---:|---|
| `src/lib/i18n.ts` (+ 4 dicts × ~9.6k) | 9,896 | `enSource` literal, 58–9761 (9,700) |
| `src/stores/tabs.ts` | 6,606 | `create<TabsStore>` body, 2661–5400 (~2,740) |
| `mobile-web/src/screens/Terminal.tsx` | 4,517 | `Terminal` component @800 (3,718; 97 `useState`, 50 `useEffect`, 57 `useRef`) |
| `src/lib/viewers/tex/tex.ts` | 3,931 | (grab-bag of ~10 subsystems) |
| `src/lib/viewers/yaml.ts` | 1,993 | — |
| `mobile-web/src/components/MarkupView.tsx` | 1,985 | `MarkupView` @298 (1,664; 51 `useState`, 55 `useRef`) |
| `src/stores/projects.ts` | 1,973 | — |
| `src/hooks/useKeyboard.ts` | 1,461 | `useKeyboard` @211 (1,163, one `useEffect`); inner `steerKey` @981 (~300), `onKeyDown` @1030 (245) |
| `src/lib/viewers/print.ts` | 1,454 | `printDocument` @503 (624, imperative DOM) |
| `src/lib/theme/customScrollbar.ts` | 962 | `installCustomScrollbars` @327 (636) |
| `mobile-web/src/screens/Project.tsx` | 789 | `Project` @151 (639) |
| `mobile-web/src/App.tsx` | — | `App` @235 (386) |
| `src/stores/detached.ts` | 1,518 | `listenDetachedHost` @1053 (379) |
| `src/stores/activity.ts` | 1,561 | `recompute` @1282 (233) |

### Duplicates

- **[High]** `src/lib/viewers/markdownEdit.ts:129` vs `src/lib/viewers/markdown.ts:120`: two exported `slugify`s run their steps in a different order, and the difference breaks links. The editor trims *before* stripping punctuation, the renderer after. A heading `Q&A ?` therefore gets the TOC anchor `#qa-` but the rendered id `qa`. On top of that, `generateToc` (markdownEdit.ts:171) adds GitHub-style `-1`, `-2` suffixes to duplicate headings, but the renderer (markdown.ts:551, 570) never de-duplicates ids. Every generated TOC link to a repeated heading is dead. *Fix:* keep one `slugify` (markdown.ts) and import it in markdownEdit. Then either give the renderer the same `-n` de-duplication (a `seen` map in `renderMarkdown`) or drop the suffixes from `generateToc`. Add a round-trip test: TOC anchor ∈ rendered ids.
- **[Med]** `mobile-web/src/tabColors.ts:15` duplicates `src/lib/theme/tabColors.ts:22` hex for hex. Its header says it is "a deliberate mirror … not an import" because the phone is its own bundle. That reason is stale: the phone already imports `src/lib/i18n`, `brand`, `untested`, `viewers/markdown`, `viewers/fileUtils`, `terminal/terminalPalette` and `agents/signInLaunch`. Both copies also have a lookup bug: they test `value in TAB_COLORS`, which also matches inherited names, so `tabColorCss("constructor")` returns a function rather than `undefined`. *Fix:* the phone imports the desktop module and keeps only `TAB_COLOR_LABELS`. Use `Object.hasOwn(TAB_COLORS, value)` in `isTabColor`.
- **[Med]** `src/lib/terminal/terminalUrls.ts:89` and `mobile-web/src/terminal/signIn.ts:95` both decide whether a URL is a sign-in link, with different rules:
  - Desktop: `client_id` plus a redirect, a response type or an oauth path; device pages `/login/device` or `/devicelogin`.
  - Phone: any of `client_id`, `code_challenge`, `response_type`, `user_code` or `challenge`; device pages `/device` or `/activate`.

  So the same link is a sign-in on one surface and not on the other. Both also re-join hard-wrapped URLs: `urlAt` on the phone, `urlContinuation` on the desktop. *Fix:* export one predicate (and one wrap-joiner) from `terminalUrls.ts`, which only imports `terminalSelection`, and have `signIn.ts` import them.
- **[Med]** The local-time `YYYY-MM-DD` formatter is written 8 times:
  - `src/lib/calendar/calendarTime.ts:68` (`toDateStr`)
  - `src/lib/agents/agentCron.ts:160` (`localDayKey`)
  - `src/components/projects/ActivityCalendar.tsx:25` (cross-scope)
  - `mobile-web/src/screens/Calendar.tsx:28` and `:30`
  - `mobile-web/src/todoDates.ts:20` (`localDate`)
  - `mobile-web/src/terminal/chatTimes.ts:28` (`chatDayKey`)
  - `mobile-web/src/agentPrompts.ts:38` (inline)

  *Fix:* `calendarTime.ts` imports nothing, so export `toDateStr` from there (or from `lib/timeFormat.ts`) and import it on both sides.
- **[Med]** Byte-size labels are written 6 times:
  - `src/lib/formatBytes.ts:16`
  - `src/lib/gpu.ts:104`: also named `formatBytes`, but MB/GB only and with a different rounding, so the same number reads differently in two panels
  - `src/lib/window/rendererWatchdog.ts:314`
  - `src/dev/perfStats.ts:130`
  - `mobile-web/src/screens/Mail.tsx:50` (`sizeLabel`) and `mobile-web/src/terminal/fileLabels.ts:15`, which are identical bodies inside the same bundle

  *Fix:* `Mail.tsx` imports `fileLabels.sizeLabel`. Rename gpu's copy to `formatMemory` or make it call `formatBytes`. The watchdog reuses one of the two.
- **[Med]** A "current window label" helper is copied 4 times, as `currentLabel()` in `src/lib/window/rendererWatchdog.ts:338`, `src/stores/viewers/pdfSync.ts:66`, `editorJump.ts:43` and `texCenter.ts:49`. `src/stores/drag/pdfDrag.ts:223` already exports the same thing as `currentWindowLabel()`. The four stores around it also repeat one "apply locally, `emit` with `from: label`, `listen` and skip `from === self`" pattern: pdfSync has 3 events (lines 146–234), plus editorJump:80–118 and texCenter:88–161. *Fix:* add `lib/window/crossWindow.ts` exporting `currentWindowLabel()` and `crossWindowChannel<T>(event, apply) → { broadcast(payload), listen(): Promise<Unlisten> }`. That removes roughly 120 lines of envelope, try/catch and self-echo boilerplate.
- **[Low]** `isUnknownCommand` (the regex `command…not found|unknown command|not allowed`) appears 3 times, identically: `src/stores/tabs.ts:5540`, `src/stores/timerLease.ts:63`, `src/lib/defaultApps.ts:16`. *Fix:* export it once from `lib/errors.ts` (or `lib/transport/`) as `isOlderBackendRefusal`.
- **[Low]** File extension from a path is computed 6 times:
  - `extOf` in `src/lib/viewers/format.ts:14`, `tex/bib.ts:123` and `yaml.ts:148` (identical)
  - inline in `highlight.ts:462`
  - a looser copy in `completion/copilotCompletionProvider.ts:12`

  `lib/paths.ts` already has `basename` and `dirname`. *Fix:* add `extname()` to `paths.ts` and use it in all five places.
- **[Low]** HTML escaping is written 5 times:
  - `src/lib/viewers/highlight.ts:78` (`escapeHtml`, fast path)
  - `src/lib/mail.ts:1080` (`escapeHtml`, same output)
  - `src/lib/viewers/odt.ts:26` (`esc`, no quotes) plus its attribute variant
  - `src/lib/viewers/print.ts:1385` (`escapeAttr`)

  *Fix:* add `lib/html.ts` with `escapeHtml` and `escapeAttr`, and have mail, odt and print import it. That is one audited escaper instead of five.
- **[Low]** The phone's base64url helpers exist 3 times: `mobile-web/src/auth.ts:5` and `localLock.ts:41`/`:47` (decode), next to the exported `secretsCore.ts:49`/`:56`. The `auth.ts` and `localLock.ts` copies use `String.fromCharCode(...bytes)`, which overflows the stack on a large buffer; `secretsCore` loops. *Fix:* import `b64url`/`unb64url` from `secretsCore.ts`.
- **[Low]** Phone screen-parser helpers are copied between files:
  - `dropLeading`: `mobile-web/src/terminal/chatTurns.ts:222` and `openCodeMini.ts:388`
  - `skipBlank` and `headingIndex`: `cursorAgent.ts:77`/`:85` and `antigravity.ts:93`/`:101`
  - `words()`: `pendingPrompts.ts:54` and `subagentInput.ts:87`

  *Fix:* move them into a `terminal/screenText.ts` and pass `headingIndex` the heading regex and the normalizer.
- **[Low]** `translate(useI18nStore.getState().lang, …)` is spelled out at 31 call sites in 24 files, each module with its own `tr` wrapper (`mobile-web/src/localLock.ts:7`, `connection.ts:114`, `src/lib/viewers/print.ts:438`, `stores/mail.ts`, `stores/projects.ts`, …). *Fix:* export `tNow(key, vars)` from `src/lib/i18n.ts` next to `useT`.
- **[Low]** `isEditableTarget` is exported from a hook file (`src/hooks/useKeyboard.ts:134`, checking INPUT/TEXTAREA/SELECT/contentEditable). `src/lib/window/strayDropGuard.ts:24` has its own `closest(EDITABLE)` version, and components inline differing tag sets: `FileTree.tsx:2116`, `FileBrowser.tsx:429` and `PdfViewer.tsx:366` (lower-case tag compare). *Fix:* add `lib/dom.ts` `isEditableTarget` (the `closest()` form) and import it everywhere.
- **[Low]** "Read validated JSON from localStorage" is hand-rolled at 8 sites:
  - `src/stores/viewers/texViewPref.ts:43` and `src/stores/remote/fileSourcePref.ts:36` (same skeleton, same name `readPersisted`)
  - `stores/rootOverlay.ts:157`
  - `stores/calendar/alarms.ts:44`
  - `lib/projects/sendToProject.ts:27`
  - phone `drafts.ts:50`, `slashCommands.ts:228`, `filesPlace.ts:35`

  The phone also declares six identical `XStorage = Pick<Storage, …>` aliases: `reloadGrace.ts:24`, `filesPlace.ts:23`, `drafts.ts:34`, `prefs.ts:12`, `lastPlace.ts:36`, `slashCommands.ts:34`. *Fix:* one `readStoredJson<T>(key, parse, fallback, storage?)` / `writeStoredJson` and one exported `KvStorage` type.
- **[Low]** `dropSlot` exists twice: `src/lib/listReorder.ts:30` (1-D) and `mobile-web/src/tabReorder.ts:32` (with an X axis). *Fix:* only if the phone needs more; otherwise name the phone one `dropSlot2d` to stop grep confusion.

### Bad practices

- **[High]** Leftovers of the old Agents-view filter, history, blame and library UI that commit `a6f43a88` replaced:
  - `src/lib/agents/prompt/filter.ts`: all 147 lines; every export is reachable only from `src/__tests__/agents/AgentPromptFilter.test.ts`.
  - `src/lib/agents/prompt/tags.ts:72–112`: `LibraryFilter`, `EMPTY_LIBRARY_FILTER`, `isLibraryFilterActive`, `filterCollectedPrompts`; test-only.
  - `links.ts:4` `PromptLinkKind`: unused.
  - About 50 `agentPrompts.*` i18n keys (`blame*`, `history*`, `filter*`, `library*`, `intro`, `none`, `copy`…; `src/lib/i18n.ts:2869–2908`), repeated in all 5 dictionaries.

  A key-reference scan found about 90 unreferenced English keys in all, other dynamic prefixes excluded. These include `remoteMachines.saveHint*`/`saveTitle*` (8 keys, superseded by `remoteConnect.*`), `mail.loadRemote`/`zone*`/`lastCheckNew`… (7), `projectDialog.alreadyThere*`/`missing*` (5) and `globalApp.role.{media_player,notes,print_manager}`. That is about 450 dictionary lines. *Fix:* delete the dead modules, tests and keys. Add a vitest that fails on an English key that no `src/`/`mobile-web/src`/`src-tauri/src` file references, with an allowlist of dynamic prefixes such as `markup.ask.hint`, `recurrence.ordinal` and `globalApp.role`.
- **[Med]** 16 exports are referenced nowhere, not even by tests: `mobile-web/src/auth.ts:184 deviceRecord`, `todoDates.ts:88 acceptedColumns`, `src/hooks/useModalFocus.ts:6 topModal`, `lib/agents/typedClear.ts:116 forgetTypedLine`, `lib/calendar/caldavPush.ts:33 CalDavRowKind`, `lib/mail.ts:796 APP_EMAILS_DIR`, `lib/transport/linkState.ts:91 isDisconnectedError`, `lib/viewers/deck/fonts.ts:197 resetMetrics` and `:425 textHeight`, `deck/model.ts:251 ObjectKind`, `viewers/fileUtils.ts:186 DECK_SUFFIX`, `viewers/pdfNotes.ts:125 notesOf`, `tex/texPreview.ts:114 clearTexPreviews`, `window/screenshot.ts:27 requestInAppCapture`, `types/index.ts:1801 boxFolderName`, `lib/agents/prompt/links.ts:4`. About 55 more are used only by tests and are not `reset*`/`*ForTest` hooks; examples: `todoBoard.ts:740 daysLate`, `stores/mail.ts:1253 unreadTotal`, `fileUtils.ts:190 isDeckFile`, `gif.ts:436 decodeGif`, `deck/model.ts:567 addObject`, `tex/tex.ts:1720 texSnippetAt`. *Fix:* delete the unreferenced ones. Review the test-only ones: drop them, or un-export them and test through the public caller. A `knip`/`ts-prune` CI step would keep this from coming back.
- **[Med]** `src/stores/timer.ts:76` (`toggle`) and `:105` (`setProject`) book `now - startedAt` without the UTC-midnight clamp that `flush` (`:128–138`) applies. The clamp exists so overnight time is not booked to today, but pausing or switching project after midnight still books yesterday's run into today's total. The flush-two-counters `Promise.all` block is also written three times. *Fix:* one `elapsedToday(startedAt, now)` with the clamp and one `flushRunning(state, now)`, used by `toggle`, `setProject` and `flush`.
- **[Med]** `src/stores/detached.ts:1053` `listenDetachedHost` awaits 13 `listen()` calls in sequence (`:1080–1224`) and then tears down 17 unlisteners by hand (`:1410–1430`). If any `listen` rejects partway, the ones already registered leak, because they have no owner. *Fix:* push each unlistener into an array as it is created, wrap the registrations in try/catch that disposes on failure, and return `() => disposers.forEach(f => f())`. A `[event, handler]` table would also shrink it by about 60 lines.
- **[Low]** In-scope code has 96 `.catch(() => {})` (14 in `tabs.ts`, 7 in `projects.ts`); most are deliberate best-effort calls. In `tabs.ts` the same two backend calls are copy-pasted: `invoke("attach_subwindow", { registryId }).catch(() => {})` 8 times (`:3314, 3364, 4057, 4246, 4490, 4883, 4918, 4959`) and `invoke("pty_kill", …)` 3 times (`:3275, 3361, 4938`). *Fix:* `closePopoutWindow(label)` and `killPty(scope, key)` helpers, plus a shared `bestEffort(p, label)` that logs in dev builds, so a rejection is visible while developing.
- **[Low]** `mobile-web/src/screens/Todo.tsx:195, 209, 225, 229` use `window.prompt` and `window.confirm` (and `api.ts:1042` uses `window.alert`), while the rest of the phone asks through sheets (`OptionSheet`, `LinkSheet`). Cross-scope: desktop `DetachedCenterPanel.tsx:2001, 2050, 2099` still call `window.prompt`, which `PromptDialogs` and `RenameDialog` were introduced to replace on WebKitGTK. *Fix:* route these through the shared sheet/dialog components.
- **[Low]** `mobile-web/src/agentPrompts.ts:51` `promptClock` formats with `toLocaleTimeString([])`, which ignores the app language and the 24-hour choice that `chatTimes.ts:21 chatTime(…, use24h)` honours. *Fix:* build it on `chatTime` and `chatDayKey`.
- **[Low]** Hook placement is inconsistent: `src/hooks/` has 7 files, while hooks also live in `src/lib/usePoll.ts`, `lib/terminal/usePathLinkContext.ts` and `lib/timeFormat.ts` (`useUse24h`). Meanwhile `hooks/useKeyboard.ts` exports a plain DOM helper. *Fix:* move hooks to `hooks/` and DOM/pure helpers to `lib/`, or document the rule in the file map.

### Simplification candidates

- **[High]** `mobile-web/src/screens/Terminal.tsx:800`: one 3,718-line component with 97 `useState`, 50 `useEffect` and 57 `useRef`. The state falls into clear clusters:
  - Voice (`listening`, `preparingVoice`, `voicePreview`, `voiceStatus`, `voiceFailure`, `readAloud`, `voiceRemote`, `voiceLocalOffered`, `speechLang`).
  - Sign-in (`signInSheet`, `hiddenSignIn`, `signedOutHidden`, `openingSignIn`, `signInError`).
  - Limits (`limits`, `limitsNow`, `limitsReadAt`).
  - Subagents (`subagentSending`, `subagentNote`, `subagentPath`, `subagentListOpen`, `subRead`, `subLimit`, `subagentNow`).
  - Seven sheet flags that appear to be mutually exclusive: `modelSheet`, `modeSheet`, `statusSheet`, `addSheet`, `commitSheet`, `desktopSheet` and `speechLangSheet` (lines 1038–1183).

  *Fix:* extract `useVoiceInput`, `useSignInFlow`, `useUsageLimits` and `useSubagentInput` hooks, and replace the sheet booleans with one `sheet: SheetId | null`. This should take the component under about 1.5k lines and make each effect's dependencies readable.
- **[High]** `src/stores/tabs.ts` is 6,606 lines, of which the `create()` body is about 2,740. It holds four separable pure layers:
  - viewer-state staging (`:401–776`) → `stores/tabs/viewerState.ts`
  - layout-tree algebra (`:1918–2660`: `findGroup`, `insertAdjacent`, `collapse`, `serializeTree`…) → `tabs/layoutTree.ts`
  - workspace sync (`:5400–6070`) → `tabs/workspaceSync.ts`
  - tab-kind predicates (`:6085–6560`) → `tabs/tabKinds.ts`

  Inside the store, "find the detached entry, filter it out, write `detachedGroupsByScope`, close the OS window" is repeated in `dropDetachedGroup`, `hideDetachedGroup`, `closeDetachedGroup` and others (`.filter((d) => d.id !== groupId)` appears 9 times). *Fix:* split along those lines and keep `tabs.ts` as the store plus re-exports. Add a `takeDetached(s, scope, groupId)` helper.
- **[Med]** `mobile-web/src/components/MarkupView.tsx:298`: a 1,664-line component with 51 `useState` and 55 `useRef`. *Fix:* split the PDF reader, the pen/marks layer and the submit/questions flow into hooks or child components, as `markup/` already does for the pure model.
- **[Med]** `src/hooks/useKeyboard.ts:211`: a single 1,163-line `useEffect`. Steering mode (`:220–980`, with its own timers, layer watch and `steerPanes`/`steerRegion`/`steerKey`) is a self-contained state machine. *Fix:* move it to `lib/shortcuts/steering.ts` as `installSteering(): () => void` and leave `useKeyboard` with the chord table and `onKeyDown`.
- **[Med]** `src/lib/viewers/print.ts:503` `printDocument` is 624 lines of imperative DOM (33 `createElement`) in one Promise executor, already divided into banner-commented sections: chrome, options row, page strip, live state, job progress, teardown. *Fix:* make each section a builder function returning its elements and handlers, or turn it into a React `PrintPreviewDialog` that uses the shared dialog classes.
- **[Med]** `src/lib/viewers/tex/tex.ts` (3,931 lines) is one module for log/diagnostics parsing, SyncTeX, PDF-point geometry, hover-preview snippets (`:1587`), `\ref`/`\cite` hits and creation, completion (`:2441–3283`), key resolution, section parsing and word count. *Fix:* split it into `tex/{log,synctex,snippets,refs,completion,structure}.ts`, the way `bib.ts` and `beamer.ts` already sit beside it.
- **[Low]** `src/lib/i18n.ts` puts the 9,700-line English dictionary in the same module as the loader, store and `useT`, while the other four languages live in `i18nDicts/`. *Fix:* move `enSource` to `i18nDicts/en.ts`, still imported statically, so `i18n.ts` is about 150 lines of machinery that can be read and reviewed.
- **[Low]** `mobile-web/src/api.ts` (1,442 lines) is one flat file of endpoint wrappers for tabs, schedules, mail, to-do, markup, files and outbox. *Fix:* split it by domain (`api/mail.ts`, `api/markup.ts`, …) around the shared `api<T>()` core at `:454`.
- **[Low]** Other long functions worth splitting when next touched: `src/lib/theme/customScrollbar.ts:327 installCustomScrollbars` (636 lines), `mobile-web/src/screens/Project.tsx:151` (639), `mobile-web/src/App.tsx:235` (386), `src/stores/activity.ts:1282 recompute` (233 lines, 9 loops over every tab: compute per-tab status once, then fold it into the scope, kind and attention maps).


## Backend — services (`src-tauri/src/services/`)

Scope: 175 `.rs` files, 179,951 lines including inline tests. Method: per-file `wc -l`; an awk brace-depth scan for function length (test modules excluded; braces inside string and char literals stripped); `rg` for repeated helper names and idioms. Hotspots were then sampled by hand. Deliberate designs were checked against `docs/filemap_backend.md` and the AGENTS.md invariants before anything was flagged. Read-only: nothing was edited or built.

### Size hotspots

| File | non-test lines | total | note |
|---|---:|---:|---|
| `mobile_control/host.rs` | 6,632 | 11,205 | about 300 fns: the whole phone HTTP surface in one file |
| `mail_store.rs` | 4,053 | 6,700 | |
| `git_peer.rs` | 3,593 | 5,427 | |
| `root_mcp.rs` | 3,450 | 5,357 | `tool_schemas` alone is 290 lines |
| `openvpn.rs` | 2,777 | 3,848 | Linux, Windows and macOS backends with cfg twins |
| `agent_session.rs` | 2,437 | 4,524 | |
| `mail_engine.rs` | 2,324 | 3,318 | |
| `agent_fence.rs` | 2,294 | 3,383 | |
| `mobile_control/protocol.rs` | 1,960 | 2,883 | mostly types (34 fns), acceptable |
| `vm.rs` | 1,956 | 2,405 | |

| Longest non-test functions | lines |
|---|---:|
| `launch_prep.rs:475 prepare` | 578 |
| `git_peer.rs:1277 transfer_and_apply` | 396 (13 indent levels) |
| `mail_store.rs:531 migrate` | 304 |
| `root_mcp.rs:1206 tool_schemas` | 290 (schema data, low priority) |
| `mobile_control/pty_bridge.rs:465 attach` | 251 |
| `git_peer.rs:2405 reconcile_with` | 224 |
| `mobile_control/host.rs:6381 run_with` | 203 |
| `mobile_control/markup_pdf.rs:276 object` | 192 |
| `mail_store.rs:3481 rekey_step_inner` | 173 |
| `vm.rs:1518 ensure_booted` | 169 |
| `root_mcp_review.rs:476 call` | 167 |
| `mobile_control/host.rs:6065 router` | 161 |

### Duplicates

- **[High]** `storage.rs:146` (private `write_bytes_atomic_unlocked`), `mobile_control/store.rs:22`, `mail_crypt.rs:635`, `connect.rs:138`, `mobile_control/web_client.rs:367`, `mobile_control/scheduler.rs:463`, `markup_rounds.rs:1358`, `dev_todo.rs:156`, `agent_session.rs:1573`, `spell.rs:528`: there are at least 10 separate "write a temp file and rename it, maybe with 0600" implementations. Only `storage`'s version uses a unique `NamedTempFile`, fsyncs the file and its directory, and records durability steps. The others use a fixed `path.with_extension("tmp")` sibling, so two concurrent writers clobber each other's staging file. Some skip fsync, and some are not atomic at all. `connect.rs:138` hand-rolls its own copy even though the very next line (`:134`) calls `store::write_json_atomic`. *Fix:* make storage's bytes writer public with a privacy argument, e.g. `storage::write_bytes_atomic(path, bytes, Mode::OwnerOnly | Mode::Inherit)` (NamedTempFile is created 0600 on Unix; call `restrict_to_owner` on Windows). Route `store::write_bytes_atomic`, `mail_crypt::write_bytes_atomic` and the three `write_private` fns through it, then delete them.
- **[High]** `now_secs` exists 8 times: `agent_versions.rs:442`, `git_peer.rs:1043`, `local_loss.rs:88`, `markup_rounds.rs:365`, `mobile_control/alarms.rs:64`, `mobile_control/scheduler.rs:475`, `remote_sync.rs:390`, `timer_lease.rs:93`. A private ninth copy sits in `storage.rs:499`. There are also 4 `now_ms` fns with three different return types: `token_stats.rs:992` (i64), `mobile_control/host.rs:518` (u64), `net_usage.rs:65` (u64) and `root_mcp_import.rs:65` (String). Add to that `web_client.rs:397 unix_now`, `headless.rs:716 epoch_ms_now`, `outbox.rs:258 unix_secs`, and about 35 inline `duration_since(UNIX_EPOCH)` chains. *Fix:* add one `pub fn now_secs() -> u64` / `now_ms() -> i64` (in `storage` or a small `clock` module) and delete the copies.
- **[Med]** Calendar math is hand-rolled even though `chrono` is a dependency already used in 17 files:
  - `storage.rs:529 epoch_to_utc` uses a year-by-year loop.
  - `mail_ai.rs:463 civil_from_days` says in its own comment that it was "duplicated rather than shared" from `commands/screenshot.rs:300`.
  - `prompt_blame.rs:184 iso_to_epoch` and `:224 epoch_ms_to_iso` inline Hinnant's algorithm twice.
  - `schema/calendar.rs:1195 days_from_civil` is another copy.
  - There are two `iso_now` fns with different suffixes: `storage.rs:522` writes `+00:00`, `lib.rs:115` writes `Z`.

  *Fix:* use `chrono::DateTime::<Utc>::from_timestamp(..)` with `format`/`to_rfc3339_opts`, plus `NaiveDate` for date-only values. Keep one `iso_now` and document its format.
- **[Med]** Hex and SHA-256 helpers are repeated: `sha256_hex` appears at `markup_rounds.rs:375`, `sandbox.rs:1668` and `server/share.rs:707`. Related copies are `mail_store.rs:4028 hex_digest`, `exec_trust.rs:121 hex`, `app_update.rs:368 sha256_hex` (which hexes any digest), the inline loop in `mobile_control/headless.rs:1272`, and `openvpn.rs:1082 random_hex`. In all there are 21 `{:02x}` formatting sites in 19 files. *Fix:* add one `hex(&[u8])` and one `sha256_hex(&[u8])` in a shared util module.
- **[Med]** `ssh_exec.rs:783 sanitize_tmux_key` is a verbatim fourth copy of `storage::project_key` (`storage.rs:422`), whose doc says it is "the **one** copy… three copies of a path-safety rule is two too many". Meanwhile `sandbox.rs:155 sanitize_key` and `agent_session.rs:1275 sanitize_project_key` are one-line forwarding wrappers. *Fix:* call `storage::project_key` directly and delete all three fns (12 call sites). The frontend `tmuxSession.ts` mirror must keep matching.
- **[Med]** POSIX single-quoting has a shared `ssh_exec.rs:378 shell_quote` (`pub(crate)`), yet it is re-implemented inline at `agent_bin.rs:67`, `copilot/process.rs:30` and, outside this scope, `commands/ollama.rs:2792`. PowerShell `''` quoting is likewise repeated at `agent_session.rs:2107`, `sandbox.rs:1469 install_shell_quote` and `commands/printing.rs:931`. *Fix:* create one `quote` module with `posix(&str)` and `powershell(&str)` and replace the inline closures.
- **[Med]** The password/passphrase attempt loop is duplicated. `sftp.rs:222-249` (async) and `commands/ssh.rs:366-393` (sync) both: walk `secret_attempt_order`, apply `guard_first_contact` before a password, stop early on `rejected_locally`, and map `(kind, master)` to `ssh_*_base_args`. Inside `sftp.rs:258-275 secret_cmd`, the `#[cfg(unix)]` arm and the Windows askpass arm are also byte-identical. *Fix:* add `ssh_common::base_args_for(kind, master, …)` and a generic `try_secret_kinds(kinds, |kind, base| …)` driver. Collapse `secret_cmd` to `if unix || ssh_supports_askpass() { askpass } else { sshpass }`.
- **[Med]** The sliding-window rate limiter is re-implemented 4 times: `markup_mcp.rs:694 admit_in` (2 statics), `git_ci.rs:75 admit_rate`, and `root_mcp.rs:400` / `:408` (limits 12 and 6 hard-coded inline). A fixed-window variant sits at `root_mcp.rs:415`. One copy has a bug: `git_ci::admit_rate` never removes a tab's entry once it is empty, so its map grows by one key per tab for the life of the process. `markup_mcp` does prune. *Fix:* add `struct RollingLimit { window: Duration, max: usize }` plus a keyed `RollingLimits<String>`, with the limits as named consts.
- **[Med]** Random-byte helpers: `mobile_control/auth.rs:84` and `mobile_control/push.rs:67` are identical `random_bytes<N>`. `mobile_control/host.rs:1274 random_16` and `headless.rs:1272 random_rule_id` throw away the `getrandom` error, so on failure they produce all-zero ids. `web_client.rs:344 random_token` returns `Result` but uses `OsRng` and cannot fail. `openvpn.rs:1082` reads `/dev/urandom` by hand. *Fix:* use one fallible `random_bytes<N>()` (and `random_id<N>()`) in a shared module everywhere.
- **[Low]** PATH lookup is re-implemented. `remote_sync.rs:1070 which_on_path` spawns `which`/`where` on each call, even though `paths::binary_on_path` exists. `ide_detect.rs:513 find_on_path` ignores the `extra_path_dirs` and PATHEXT that `paths::resolve_executable` honours. *Fix:* use the `paths` helpers. For rsync, which is a `TRUSTED_HELPERS` member, check `helper_program` first.
- **[Low]** There are two JSON store APIs with different error types: `storage::read_json` returns `Box<dyn Error>`, while `mobile_control/store.rs:5 read_json` returns `String` with path context. Callers paper over the difference with `.map_err(|e| format!(…))`. A small instance: `agent_tasks.rs:71 write_at` calls `create_dir_all`, which `write_json_atomic` already does. *Fix:* give storage a `String`-error, path-annotated façade and drop the second API.

### Bad practices

- **[High]** `sftp.rs:205`, `:264`, `:276` spawn `tokio::process::Command::new("ssh")` with `PATH = effective_path()` (`:330`). That resolves `ssh` through the user-writable dirs `effective_path` puts first, such as `~/.local/bin`. Every other ssh spawn goes through `paths::command_no_window`, which takes `ssh`/`sftp` from root-owned system dirs first (`helper_program`, `TRUSTED_HELPERS`, #861). SFTP runs in the background (`git_peer` uses `pooled_sftp` 6 times), which is exactly the case #861 hardened. The function also hand-sets `CREATE_NO_WINDOW` at `:335`, duplicating `hide_command_window`. *Fix:* `tokio::process::Command::from(crate::paths::command_no_window("ssh"))`.
- **[High]** `mail_store.rs:638`, `642`, `646`, `655`, `659`, `679`, `693`, `694`, `809`, `813`: 10 `let _ = conn.execute("ALTER TABLE … ADD COLUMN …")` calls discard *every* error, not just "duplicate column". A locked database, full disk or I/O error leaves a half-migrated schema that fails later, far from the cause. *Fix:* add `add_column_if_missing(conn, table, col, decl) -> Result<(), String>` that checks `pragma_table_info` and propagates real errors. The same helper replaces the `prepare("SELECT x … LIMIT 0").is_err()` existence probes (`:707`).
- **[Med]** Mutex poisoning is handled three different ways. There are 155 non-test `lock().unwrap()` calls, about 35 of them in `openvpn.rs` and about 27 in `copilot/session.rs`. There are also about 90 `unwrap_or_else(|p| p.into_inner())` calls, plus `mail_store`'s `map_err(|_| "mail store is poisoned")`. Three private poison-recovering `fn lock` helpers are identical (`sheet_reader.rs:275`, `api_proxy.rs:152`, `api_usage.rs:332`). In `openvpn`, one panic under a registry lock poisons it, and from then on `disconnect_all()` panics too, and that runs in the exit teardown. *Fix:* add one `crate::sync::lock(&m)` that recovers from poison and replace the `.lock().unwrap()` calls.
- **[Med]** `mobile_control/web_client.rs:367 write_private` truncates and rewrites the login token in place. Per `login_token`'s doc, "whichever runs first writes the file the other reads". A reader racing the writer sees a short file, fails the `len() >= 32` check, and mints and writes a *second* token. The Windows branch is a plain `fs::write` without `restrict_to_owner`. *Fix:* use `store::write_bytes_atomic(path, bytes, 0o600)` (or the unified writer above), with `create_new` for the first mint.
- **[Med]** `mail_crypt.rs:635 write_bytes_atomic` writes the mail key file with `fs::write`, which uses umask permissions, and only *then* chmods it to 0600. That leaves a window where the wrapped key is readable by group or world. It never fsyncs either, although its doc says "a half-written one is an unopenable mailbox". In `openvpn.rs:361`, `fs::copy`, which keeps the source's mode, is followed by `let _ = set_permissions(0o600)`; `.ovpn` files often carry inline keys. *Fix:* create the file with its mode up front through the unified atomic writer.
- **[Med]** Two `harden(path, mode)` fns in the same mail subsystem disagree on Windows. `mail_crypt.rs:646` calls `private_file::restrict_to_owner`. `mail_store.rs:4040` is a no-op, and its doc claims the profile ACL is enough. *Fix:* keep one `harden` (the `restrict_to_owner` one) and share it.
- **[Med]** Dead code. `sftp.rs:951 download_on` and `sftp.rs:1109 download` are both marked `#[allow(dead_code)] // wired by … Phase 3/5 follow-up`, but they have no callers. They were superseded by `download_file_streaming_on`, and they read the whole file into RAM. Separately, `remote.rs:491 pooled_sftp` carries a stale `#[allow(dead_code)] // consumed by Phase 2/3`, though `git_peer` calls it 6 times. *Fix:* delete the two fns and drop the attribute.
- **[Med]** Misleading names:
  - `mobile_control/host.rs:3576 schedule_desktop_error` and `:4029 prompt_desktop_error` build the **success** response too; they are response mappers.
  - `app_update.rs:368 sha256_hex` hexes an arbitrary digest.
  - `root_mcp_import.rs:65 now_ms` returns a `String`.

  *Fix:* rename them to `schedules_response`/`prompts_response`, `hex`, and `now_ms_string` (or return a number).
- **[Low]** `schedule_mcp.rs:177 refusal_reason` classifies refusals by matching a text prefix of `content[0].text` against a hard-coded list. The sibling lanes (`git_push_mcp.rs:1097`, `markup_mcp.rs:720`) read a typed `structuredContent.category`. *Fix:* emit `structuredContent {status, category}` in the schedule lane and share one `refusal_reason`.
- **[Low]** `mobile_control/host.rs:793` hard-codes `Max-Age=43200` in the session cookie instead of using `auth::SESSION_MAX` (12 h). The two can drift apart. *Fix:* `format!(…Max-Age={}, auth::SESSION_MAX)`.
- **[Low]** `agent_fence.rs:1036` and `:1050` use `args.iter().position(|a| a == "--").unwrap()`, so argv assembly panics if the invariant ever breaks. *Fix:* return `Err` so the spawn still fails closed, but without a panic.
- **[Low]** `skills.rs:144` runs `git pull --ff-only` (a merge verb) through plain `command_no_window("git")` instead of the hardened git builder. The repo is Tabtivity's own cache clone, so the risk is low, but it is the one background merge outside the hardened path. *Fix:* use the `hookless_` hardened builder.

### Simplification candidates

- **[High]** `mobile_control/host.rs`: 6,632 non-test lines and about 300 fns in one file. Inside it:
  - `state.config.control_dir.join("desktop-control.sock")` is repeated **46** times, with no constant.
  - `Base64UrlUnpadded::encode_string(&random_16())` is repeated **44** times to mint request ids.
  - 22 separate mappings turn `"desktop_unavailable"` into 503.
  - `type ApiRefusal` is declared at `:5435`, yet 45 signatures still spell out `(StatusCode, Json<Value>)`.

  *Fix:* add `HostState::ask_desktop(|request_id| DesktopRequest::…)` (socket plus id plus call) and `fn desktop_code_status(code) -> StatusCode`, and use `ApiRefusal` everywhere. Then split the routes into `host/{tabs,schedules,prompts,inbox_outbox,files,markup,mail,calendar,auth}.rs` with `router()` in `host/mod.rs`.
- **[High]** `launch_prep.rs:475 prepare` is 578 lines: about 15 sequential stages, each behind its own comment banner. The stages are control-env strip, authority re-derivation, VM refusal, local-mirror cwd, O#149 cwd gate, resume, fence roots, generation, MCP lanes, OpenCode models, fence decision and docker/ssh/tmux wraps. *Fix:* extract each stage into a named fn on a `Prep` struct holding `opts`, keeping today's order and comments. A stage-order unit test then pins the security-relevant ordering. No behaviour change.
- **[Med]** `git_peer.rs:1277 transfer_and_apply` is 396 lines, nests 13 levels deep, and has 8 params including two bools (`to_remote`, `force`). It calls `dst_sha.unwrap()` 3 times (`:1458`, `:1564`, `:1575`), each made safe only by the enclosing match arm. *Fix:* split it into `bundle_and_fetch()` and `apply_ref()`/`apply_tag()`. Make `RefAction` variants carry the dest sha (`DestAhead { dst }`, `Diverged { dst }`) so the unwraps disappear. `reconcile_with` (`:2405`, 224 lines) is the next candidate.
- **[Med]** `mail_store.rs:1295-1532`: `headers_page`, `headers_page_marked`, `folder_search_page` and `page` take 8–9 positional params under 4 `#[allow(clippy::too_many_arguments)]`, and repeat the same scope SQL literals. The file also has 210 `.map_err(|e| e.to_string())` in non-test code. *Fix:* add `struct PageQuery { offset, limit, query, sort, desc, unread_only }` and `enum Scope { Folder, Marked }`. Add a local `fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String>` (or a `StoreError` with `From<rusqlite::Error>`) so `?` works directly.
- **[Med]** `openvpn.rs` is 2,777 non-test lines covering three OS backends, and three functions are duplicated per OS differing only in which registry they read. `active_configs` is at `:1335` and `:1348`; `disconnect_all` at `:1798` and `:2716`; `disconnect_all_checked` at `:1828` and `:2730`. The duplication has already let behaviour drift: the macOS `disconnect_all` does not skip `is_declined` configs, while the Linux/Windows one does. *Fix:* add one cfg-dispatched `fn registered_configs() -> Vec<String>` and write each of the three fns once. Split the module into `openvpn/{linux,windows,macos}.rs`.
- **[Low]** `mail_store.rs:531 migrate` is 304 lines with additive ALTERs, two v1→v2 table rebuilds and data fix-ups inline. *Fix:* use `migrate_additive_columns()`, `rebuild_folders_v2()`, `rebuild_remote_allow_v2()` and `normalize_dates()`, built on the `add_column_if_missing` helper above.
- **[Low]** `copilot/session.rs:170`: `a["title"].as_str().unwrap()` is safe only because of a filter three lines up. *Fix:* collect titles with `filter_map(|a| a.get("title")?.as_str())` once and reuse them, which removes both the filter and the unwrap.


## Backend: commands, app shell, server crates

Scope: `src-tauri/src/commands/` (77 files, 77.1k lines incl. tests), `src-tauri/src/{lib,sysstat,gpustat,paths,storage,duscan,tauri_host}.rs`, `terminal/`, `platform/`, `schema/`, `src-core/`, `src-gateway/`, `src-serverd/` (15 lines, only a `main` shim). Read-only review; nothing was built or run. Line numbers are from `develop` @ 211451c1.

Method: `wc -l`, a brace-counting scan for function lengths that skips `#[cfg(test)]` modules, and `rg` for repeated helper names, preambles and error mapping across files. Hotspots were then sampled by hand. Before flagging anything I checked `docs/filemap_backend.md`, `tauri_host::CONVERTED_COMMAND_FILES`, `build.rs` and the AGENTS.md invariants. Deliberate patterns are excluded: per-OS `cfg` twins, the gateway's `#[path]` wire sharing, pure parsers compiled on every OS for cross-OS tests, and best-effort cleanup `let _ = remove_*`.

### Size hotspots (table)

| File | Total lines | Non-test lines | Notes |
|---|---:|---:|---|
| `commands/projects.rs` | 6610 | ~5010 | 61 commands; the filemap calls it a "god module, #1" |
| `commands/ollama.rs` | 6154 | ~4690 | install, registry scraping, pulls, FIM completion and local-agent launch, all in one file |
| `commands/mail.rs` | 5841 | ~5000 (tests are interleaved) | 79 commands |
| `commands/git.rs` | 5732 | ~3640 | status, history, worktrees and the hardened-git primitives |
| `commands/tex.rs` | 3937 | ~2770 | |
| `commands/fs.rs` | 3778 | ~2530 | |
| `src-tauri/src/sysstat.rs` | 3585 | ~2710 | 4 inline `mod platform {}` blocks of 250–480 lines each |
| `commands/apps.rs` | 3089 | ~2500 | |
| `src-tauri/src/lib.rs` | 2749 | ~2570 | `run()` alone is **1,382 lines** (1182–2564) |
| `commands/agents.rs` | 2638 | ~2230 | |

| Longest functions (non-test) | Lines |
|---|---:|
| `lib.rs:1182 run` (setup closure ≈240, `generate_handler!` ≈840, `RunEvent` closure ≈186) | 1382 |
| `commands/sync.rs:541 sync_status` | 345 |
| `commands/project_transfer.rs:1225 import_project_export_blocking` | 306 |
| `commands/tex.rs:1193 compile_tex_blocking` | 256 |
| `commands/mail.rs:2280 sync_inner` (indent depth 8) | 248 |
| `commands/project_transfer.rs:624 export_project_blocking` | 226 |
| `schema/calendar.rs:789 normalize_tasks` | 226 |
| `commands/projects.rs:4070 create_claimed_project` | 197 |
| `commands/git.rs:1212 git_file_statuses_blocking` | 197 |
| `terminal/mod.rs:1897 launch` | 196 |
| `commands/remote.rs:86 remote_connect` | 194 |
| `commands/subwindow.rs:235 detach_subwindow` | 191 |
| `commands/ollama.rs:2352 list_installable_models` (a hard-coded literal table) | 182 |

16 non-test functions in `commands/` are longer than 150 lines, and 35 are longer than 100.

### Duplicates

- **[High]** `commands/{apps.rs:396, calendar.rs:1180, fs.rs:797, git.rs:753, hpc_ws.rs:440, projects.rs:922, python.rs:406, skills.rs:11, slurm.rs:213, sqlite.rs:152}` `run_off_thread` and `commands/{share.rs:24, shared_calendar.rs:20}` `off_thread` — **12 copies** of the same 5-line `spawn_blocking(f).await.map_err(|e| format!("<x> task failed: {e}"))?`. The pattern is also written out inline about **284 more times** in `commands/` (101 of them in `mail.rs`). Three different runtimes are used: `tokio::task::spawn_blocking` 192×, `app_core::rt::spawn_blocking` 82×, `tauri::async_runtime::spawn_blocking` 10×. *Fix:* add one `app_core::rt::blocking(label, f) -> Result<T, String>` that flattens the join error, delete the 12 copies, and sweep the inline sites onto it. That saves roughly 600 lines and leaves one runtime seam, which the hosted plan already wants (`rt::spawn_blocking` reaches the host runtime from any thread).
- **[High]** `commands/mail.rs` (54× `let rt = state.clone();`, 41× `store_of(&rt)?`, 22× `.map_err(|e| e.to_string())??`) — nearly every mail command repeats the same block: `let state = ctx.get::<MailState>(); let rt = state.clone(); tokio::task::spawn_blocking(move || store_of(&rt)?.op(..)).await.map_err(|e| e.to_string())?`. Examples: `mail_priority_set` at :3143 and `mail_replies` at :2793. *Fix:* `async fn with_store<T>(ctx: &Ctx, f: impl FnOnce(&MailStore) -> Result<T,String> + Send + 'static) -> Result<T,String>`. About 40 commands drop to 1–3 lines each, roughly 200 lines saved.
- **[High]** `commands/projects.rs:747`, `services/agent_fence.rs:252`, `services/remote.rs:147`, `commands/fs.rs:2100` (`project_dir`) — **four** versions of "a registry entry's directory" that **behave differently**:
  - `projects.rs` returns the raw `String`.
  - `remote.rs` returns `&str` and accepts an empty value.
  - `agent_fence.rs` trims the value and falls back to `local_file.strip_suffix("/project.json")`. That literal never matches a Windows `\` path.
  - `fs.rs` falls back to `Path::parent()`.

  There are also 7 more raw `extra.get("directory")` reads in `projects.rs` (633, 1805, 2570, 4635, …), plus `git.rs:3607` and `boxes.rs:182`. *Fix:* one `ProjectEntry::directory() -> Option<PathBuf>` in `schema/projects.rs` using the trimmed, non-empty, `Path::parent` fallback semantics, and call it from every site. This removes a real cross-OS divergence in the fence's input.
- **[High]** `src-gateway/src/{hub.rs:771-820, keeper.rs:740-790, calendars.rs:516-570}` — the per-uid connection cap (`PerUid`, `UidSlot`, `take`, `Drop`), the `serve` accept loop (accept, `peer_cred`, slot, semaphore, spawn with timeout) and `read_line` are copied three times. Only the log tag and the deadline differ. The three `read_line`s have also drifted apart: buffers of 8 KiB, 1 KiB and 64 KiB, and the length check sits before the read in two of them and after it in one. `new_id()` is duplicated too (`hub.rs:763`, `calendars.rs:111`). *Fix:* a `src-gateway/src/uds.rs` with `serve_capped(listener, max_conn, max_per_uid, deadline, tag, handler)`, `read_line(max)` and `new_id()`. About 150 lines saved, and a fix to one cap reaches all three sidecars.
- **[Med]** `commands/caldav.rs:92-122` vs `commands/mail.rs:1136-1166` — `upsert_account_at`, `delete_account_at` and `account_by_id` are line-for-line identical; only the type and the word "CalDAV"/"mail" differ. *Fix:* a small generic `AccountsFile<T: HasId>` helper (or a macro) taking `read_accounts`/`write_accounts` as parameters. `mail.rs` keeps its own sealed `write_accounts`.
- **[Med]** `commands/git_publish.rs:900` vs `commands/git_hosting.rs:216` — `find_entry` is copy-pasted; the doc comment even says "Mirrors the helper in `commands::git_publish`". Both re-implement `projects::read_projects_list()` (`projects.rs:355`) inline. *Fix:* delete both and use `read_projects_list()?` with `position`, or add `projects::find_entry`.
- **[Med]** `storage::state_dir().join("projects.json")` is spelled out 20× in `commands/`+`lib.rs` and 33× in `services/`. `…join("settings.json")` appears about 20× in non-test code. There are 4 private `read_settings()` (`browser.rs:134`, `git_hosting.rs:136`, `mail.rs:512`, `ollama.rs:94`) with three different behaviours: `Option`, `Option` via `.then`, and `unwrap_or_default`, which swallows a corrupt file. *Fix:* add `storage::{projects_path, settings_path, load_settings() -> Option<Settings>}` and route every site through them.
- **[Med]** Subprocess error text is rebuilt in five helpers: `git.rs:3217 git_err`, `git_pull.rs:89/93 stdout_of/err_of` (the same thing, but trimmed), `git_publish.rs:916 run_command`, `agents.rs:1052 run_capture` and `ssh.rs:269 capture/capture_raw`. There are also 38 inline `String::from_utf8_lossy(&out.stderr)` decodes in non-test code, 14 of them in `git.rs`, which already has `git_err`. *Fix:* one `paths::output_error(&Output) -> String` (stderr, else stdout, else the status) plus `paths::run_capture(cmd, what)`, and use them everywhere.
- **[Med]** POSIX single-quoting is written five times: `commands/ollama.rs:2791 sh_single_quote`, `services/ssh_exec.rs:378 shell_quote` (the canonical one, documented "so command modules share this one implementation"), and inline in `services/agent_bin.rs:67`, `services/copilot/process.rs:30` and `services/sandbox.rs:1473`. PowerShell quoting appears twice (`commands/printing.rs:931 ps_quote`, `services/sandbox.rs:1471`). *Fix:* move both helpers to a neutral `paths::{sh_quote, ps_quote}` and delete the copies. This is cross-scope for the `services` ones.
- **[Med]** `lib.rs:1047-1174` — the 15 singletons are listed **five times**: the `Singletons` struct, `Singletons::new`, the 15-parameter free `core_state(...)` (with `#[allow(clippy::too_many_arguments)]`), the forwarding call in `Singletons::core_state`, and the destructure plus `.manage(..)` chain in `run()` (1257–1294). *Fix:* inline `core_state` into the method (`CoreState::new().manage(self.x.clone())…`) and add `fn manage_all(self, b: Builder) -> Builder`. Better still, a declarative `singletons! { name: Type = init, … }` macro that generates all five. Adding a singleton then touches one line.
- **[Low]** `commands/mobile_control.rs:117-142` re-opens `arboard` to read the clipboard image even though `commands/clipboard.rs:46` already reads it and encodes PNG (and `mobile_control` calls `clipboard::encode_png`). *Fix:* expose a `clipboard::read_image_png()` and call it from both places.

### Bad practices

- **[High]** Layering inversion: **196 references from `services/` into `crate::commands::`**. Services depend on primitives that live in command files:
  - `commands::calendar::read_data` (28 refs) and its 16 `*_at` store functions
  - `commands::projects::uuid_v4` (21 refs), `patch_project_entry_mirrored` (10)
  - `commands::git::hardened_git_command_in` / `hookless_git_command_in` (18 refs, at `git.rs:571/592`)
  - `commands::boxes::box_id_of_scope`

  That contradicts AGENTS.md's "keep `services/` AppHandle-free and unit-testable" layering, and it is why `projects.rs`, `calendar.rs` and `git.rs` cannot shrink. *Fix:* move the pure stores and primitives down:
  - `services::project_registry` (read/patch list, entry lookup, `uuid_v4`, mirrored patch)
  - `services::calendar_store` (`read_data`, `*_at`)
  - `services::git_cmd` (hardened/hookless builders)

  Leave `pub use` re-exports in `commands` for one release. AGENTS.md names `commands::git::hardened_git_command_in` and would need a one-line update.
- **[High]** String errors with no shared type. There are **431** `.map_err(|e| e.to_string())` and 186 `.map_err(|e| format!(…))` in non-test command code; `mail.rs` alone has 125 and `projects.rs` 63. Phrasing drifts: `"project '{id}' not found"` 11×, `"Project not found"` 7×, `"project not found"` 2×, `"unknown project {id}"` 1×. *Fix:* a `CmdError(String)` that serializes as a plain string (the wire format is unchanged), with `impl<E: std::error::Error> From<E>`, so `?` works directly. Add constructors for the recurring cases (`CmdError::project_not_found(id)`). `build.rs`'s `Ret::Result` detection must accept it; it only matches `Result<`. Migrate file by file.
- **[Med]** Mutex poisoning is handled two ways. `commands/`, `terminal/` and `lib.rs` hold about 85 `lock().unwrap()`/`.expect` calls (e.g. `apps.rs:233,445`, `credentials.rs:93`, `subwindow.rs:916…1471`, `terminal.rs:305`, `terminal/mod.rs:889,1039`, `lib.rs` `RunEvent` closure). `services/` (mobile_control/host 43×, git_push_mcp 14×, …) and the gateway use `unwrap_or_else(PoisonError::into_inner)`. One panic while holding the window or PTY registry turns every later command into a panic. *Fix:* a `trait LockExt { fn lock_ok(&self) -> MutexGuard<T> }` in `app_core`, used everywhere (or `parking_lot`).
- **[Med]** Business logic in command files that should be AppHandle-free services:
  - `commands/mobile_control.rs:420-1080` installs and uninstalls the Mobile host as a systemd, launchd or Windows service: unit/plist generation, binary install and pruning, enable/disable. That is about 650 lines of pure service code.
  - `commands/root_mcp.rs` holds the whole axum listener: semaphore-bounded accept, `AsyncRead` wrappers, `handle` at 178 lines. Its header still says "the `AppHandle` half", even though the file is on the Tauri-free `CONVERTED_COMMAND_FILES` list, so the comment is stale.

  *Fix:* move these into `services::mobile_control::install` and `services::root_mcp::listener`, and leave thin commands behind.
- **[Med]** `commands/agents.rs:1514` `agent_tab_transcript` and `:1604` `agent_tab_changes` take the same 10 positional parameters ("Takes `agent_tab_transcript`'s arguments"). Both carry `#[allow(clippy::too_many_arguments)]`, and they fan out into 7–8-parameter service calls and `arm_transcript_watch` (7 params, another allow). *Fix:* one `#[derive(Deserialize)] TranscriptQuery` borrowed through to `services::agent_transcript`/`agent_changes`. This changes the payload shape, so the frontend `invoke` has to change at the same time. The same applies to `mail.rs` `mail_headers`/`mail_search`/`mail_priority_page` (8–9 params) and `copilot.rs:146 copilot_complete` (12 params).
- **[Low]** Errors discarded silently where the caller expects persistence:
  - `commands/mail.rs:521 set_encrypt_preference` does `let _ = storage::patch_json(...)`, so the encryption preference can be lost without anyone noticing.
  - `commands/ollama.rs:1053` drops the `write_json` of the pending-pulls list.
  - `commands/projects.rs:4131` and `:4518` drop `create_dir_all(mirror)`, while the sibling branch at `:4124` propagates the same error.

  *Fix:* propagate the error, or at least `eprintln!` it as the rest of the file does.
- **[Low]** `terminal/mod.rs:41-42` — `MIN_RESTART_INTERVAL` is dead (only defined, never read) and hidden behind `#[allow(dead_code)]`. *Fix:* delete it.
- **[Low]** `commands/printing.rs:444-638, 929-1013` put 20 item-level `#[cfg_attr(target_os=…, allow(dead_code))]` on the CUPS and Windows parsers, which are compiled on every OS on purpose for tests. *Fix:* move each group into a `printing/{cups_parse,windows_parse}.rs` submodule with one module-level `cfg_attr`. Same treatment for `apps.rs:1453-1567`.
- **[Low]** `commands/connect.rs:111+` uses bare `#[tauri::command]` while every other file uses `#[cfg_attr(feature = "desktop", tauri::command)]`. The module is desktop-gated, so this works, but it breaks the grep-able convention. *Fix:* switch to the `cfg_attr` form.
- **[Low]** `commands/agents.rs:2040-2041` calls `find_spec(agent)` twice and then `path.expect("checked above")`. *Fix:* `if let (Some(spec), Some(path)) = (find_spec(agent), path) { … }`. Likewise `git.rs:165` `rest.next().unwrap()` after a `peek`: use `while let Some(c) = rest.next_if_eq(&"-c")`.
- **[Low]** `commands/screenshot.rs:452` reimplements a PATH lookup instead of calling `crate::paths::binary_on_path`. `format.rs:33` and `tex.rs:99` define one-line `on_path` wrappers around `paths::*`. *Fix:* call `paths::` directly.

### Simplification candidates

- **[High]** `lib.rs:1182 run()` (1,382 lines). *Fix:*
  - Extract the `.setup` closure (1295–1534) into `fn on_setup(app, core_state, …)`.
  - Extract the `RunEvent` closure (2378–2564) into `fn on_window_destroyed(app, label)` and `fn on_exit(app)`.
  - Move the async-signal-safe crash logger (`install_crash_logger` … `format_crash_line`, lines 67–575, about 500 lines) and the webview crash reporter (575–770) into `crash_log.rs` and `webview_crash.rs`.

  The `generate_handler!` list stays, but `lib.rs` drops from about 2,570 to about 1,100 non-test lines.
- **[High]** `commands/projects.rs` (about 5,010 non-test lines, 61 commands). It already has section headers, so split along them into `projects/{registry,archive,rename,settings (the ~25 set_project_* setters),scaffold,migration,create_import,remote_extend}.rs`. This goes together with moving the registry primitives into `services::project_registry` (see Bad practices).
- **[High]** `commands/ollama.rs` (about 4,690 non-test lines). *Fix:* split into `ollama/{addr_http (74-370), install (396-760), models_registry (764-2350), catalog, gpu_service (2572-3200), completion (3281-3820), local_launch (3821-4690)}.rs`. Completion logic could move next to `app_core::services::text_completion`.
- **[Med]** `commands/sync.rs:541 sync_status` (345 lines, indent depth 7). `SyncStatusEntry { … 11 fields … }` is written out 4+ times with mostly constant fields (575, 590, 608, 627), and the partition logic (selected, dir, lockstep, cold pool) is pure. *Fix:* add `SyncStatusEntry::unchecked(rel, is_dir, selected, state, auto, excluded)` and move the classification into `services::remote_sync::classify_rows(snapshot, lockstep, live)` so it can be unit-tested. That saves about 60 lines and leaves the command as I/O only.
- **[Med]** `commands/project_transfer.rs:1225 import_project_export_blocking` (306 lines) and `:624 export_project_blocking` (226 lines) are already divided by `// ── Where it lands / Unpack / Re-point / project.json / Register / Session, time, boxes` comments. *Fix:* turn each section into a function that takes and returns a small `ImportPlan` struct. Same for `tex.rs:1193 compile_tex_blocking` (256 lines, flat but long) and `mail.rs:2280 sync_inner` (248 lines, depth 8): pull the per-folder header sync into `sync_folder(...)`.
- **[Med]** `src-tauri/src/sysstat.rs` (3,585 lines) contains four inline `mod platform { … }` blocks: Linux 1561–1805, Windows 1806–2182, macOS 2183–2661, and a stub. *Fix:* move them to `sysstat/{linux,windows,macos,other}.rs` with `#[cfg] #[path]` or plain submodules. The façade stays about 1,500 lines and each OS file can be reviewed separately.
- **[Med]** `commands/remote.rs:86 remote_connect` (194 lines) calls `remote_target_for_host(&project_id, &host_id)` three times (108, 118, 210) and mixes primary and worker post-connect steps. *Fix:* resolve the target once, then `on_primary_connected(...)` and `on_worker_connected(...)` helpers.
- **[Low]** `commands/ollama.rs:2352 list_installable_models` is a 182-line `vec![CatalogEntry{…}]` literal with English, user-facing descriptions in backend code. *Fix:* `include_str!("ollama_catalog.json")` parsed once (`LazyLock`). Better still, ship ids only and let the frontend's i18n carry the descriptions (AGENTS.md: display text goes through `i18n.ts`).
- **[Low]** `commands/apps.rs:2300-2430` holds 12 `cfg`-gated `list_window_ids`/`find_window_for_pid`/`find_new_window` wrappers. The Windows and macOS ones only forward to `crate::platform::{windows,macos}`, while the Linux X11 body is inline. *Fix:* move the X11 bodies into `platform/x11.rs` and expose one `crate::platform::{list_window_ids,…}` façade, so `apps.rs` calls a single function.
- **[Low]** `commands/projects.rs:2510 set_project_categories` repeats the insert/remove `match` for `entry.extra` and `project.extra`. *Fix:* a `set_or_remove(&mut Map, key, Option<Value>)` helper (also usable by other mirrored setters). `set_project_schedule_mcp` (1927) and `set_project_git_push_mcp` (1938) each parse `"off"|"propose"|"apply"` by hand. *Fix:* `impl FromStr for git_push_mcp::Level`.
- **[Low]** `src-gateway/src/{wire,hub_wire,cal_wire,keys_wire,oidc_wire,policy}.rs` each carry a module-wide `#![allow(dead_code)]` because they are compiled into two crates by `#[path]`. The gateway avoids `app-core` on purpose, so a dependency-free `app-wire` workspace crate (std + serde) would remove the six `#[path]` includes and the blanket allows without breaking that rule. The same goes for the `Reply::ok/error` constructors duplicated across `cal_wire.rs:172`, `hub_wire.rs:155` and `keys_wire.rs:283`.
