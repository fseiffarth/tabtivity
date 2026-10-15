# Whole-project screen 2026-10-15 Medium findings — handoff

Per-agent handoffs and review reports of the run, concatenated. Plan: `docs/screen_2026_10_15_medium_plan.md`.

---

## Handoff M1: i18n (screen 2026-10-15 Medium)

Branch `screen-med-m1` (worktree `.claude/worktrees/med-m1`), from develop `2f0569c5`.
Commit: **`39f91ae5`** fix(i18n): carry display strings past the component boundary; placeholder test on raw dicts.

## Done (per plan M1)
- **i18n test** (`src/__tests__/shell/i18n.test.ts`): the placeholder check compares `enSource` with the raw `de/es/fr/it` `dict` exports (before `fillBrand`), as **sets, in both directions**. It failed on 10 entries before the fix: the 2 known ones (`shortcutHelp.steeringIntro` ×4 dropped `{app}`; `steering.popout.desc` ×4 added `{app}`, now follow English: "…Die Navigation endet…") and 2 the old test missed: `tour.arrangeTabsBody` (de dropped `{app}`), `lessons.keyboardSteering.moveFocusBody` (es dropped `{app}`). All fixed.
- `stores/projects.ts` (only the 3 string regions: `vpnToast` → `vpnAutoConnect.upToast`; the remote switch toast → `projectsStore.switchToastRemote`; stop-sessions error → `projectsStore.stopSessionsFailed`).
- `vpnAutoConnect.ts` `pollVpnUp` toast → `vpnAutoConnect.upToast`.
- `remoteConnect.ts` root-login toast → `remoteConnect.authInRootToast`.
- `wsInternals.ts` dialog shim: the default OK/Cancel/Yes/No labels the user sees are `common.ok/cancel/yes/no`; the **answer tokens stay English** ("Ok"/"Yes"/"Cancel"/"No"), because plugin-dialog's `ask`/`confirm` compare the answer with those. English label is now "OK" (was "Ok"); `WebTransport.test.ts` updated + a German test.
- `clientAdapters.ts` errors → `clientAdapters.newTabBlocked/noFileManager/nonWebUrl` (the `open_in_file_manager:` prefix dropped from the text).
- `calendarTime.ts`: `formatTime(hhmm, use24h, lang = app lang)` (AM/PM from `calendarTime.am/pm`; es = "a. m."/"p. m."), `formatStampTime` same, `formatLongDate(date, locale = dateLocale())` (was `"en"`). Callers of `formatLongDate` already pass `lang`; the ~20 `formatTime` callers were **not** edited (the default reads the app language; all are in components that re-render on a language change via `useT`). Choice made to avoid touching files other agents own.
- `AppResourceDisplay.tsx`: CPU/RAM/GPU labels, the CPU/RAM titles (now descriptive), the collapsed-cluster label. `lib/gpu.ts` `gpuAdapterTooltip`/`gpuTooltip` take `lang` (default app language); the row labels are padded to one column per language.
- **Sibling bug fixed:** `ModelsHubSections.tsx:1274` `gpus.map(gpuAdapterTooltip)` would have passed the array index as `lang` → now `gpus.map((gpu) => gpuAdapterTooltip(gpu))`.
- **sw.js push titles** (decision as planned): new `mobile-web/src/pushTitles.ts` (placeholder, table builder from `TRANSLATIONS`, stamper, `rememberPushLanguage()`); `stampServiceWorker` stamps `__APP_PUSH_TITLES__` (only the closeBundle write line + 2 imports + doc lines — the `define` block untouched, M6's region). The page (`main.tsx`) writes its language to Cache Storage `NAMES.mobilePushLangCache` (`<slug>-mobile-prefs`, entry `/__push-lang`) on load and on change; `sw.js` `activate` spares that cache; the push handler reads it → `navigator.language` → English. Unstamped (dev) the worker still shows English. Verified the emitted `mobile-dist/sw.js` carries all five languages.
- `src/lib/brand.ts`: new `NAMES.mobilePushLangCache` (frontend-only; added to `BrandMirror.test.ts` FRONTEND_ONLY + sw.js spelling check).

## New i18n keys (all five languages)
`projectsStore.switchToastRemote`, `projectsStore.stopSessionsFailed`, `remoteConnect.authInRootToast`, `clientAdapters.newTabBlocked`, `clientAdapters.noFileManager`, `clientAdapters.nonWebUrl`, `appResource.cpuLabel/ramLabel/gpuLabel/cpuTitle/ramTitle`, `gpu.tip.busy/vram/shared/temp/power/clocks/link/ollama`, `mobile.push.titleAgentDone/titleAgentQuestion/titleCalendar`, `calendarTime.am/pm`.

## Gotchas for the merge
- M2/M3/M7 keys from their handoffs go into `i18n.ts` + all four dicts; the new parity test now also fails on an **extra** placeholder in a translation, not just a dropped one.
- M6 edits the `define` block of `vite.mobile.config.ts`; M1 touched only imports, the plugin doc comment and the `writeFileSync` line in `stampServiceWorker`. M6's "unchanged bundle → same cache name" is unaffected (titles don't touch `__APP_BUILD__`), but sw.js bytes now also change when a push-title translation changes (intended: new worker).
- `calendarTime.ts` now imports `lib/i18n` (doc comment updated: "no React components").
- `mobile-web/src/pushTitles.ts` must avoid ES2021 lib calls (`replaceAll` failed `tsc -p tsconfig.mobile.json`).

## Gates (worktree, Linux)
- `scripts/gates.sh`: brand PASS, whitespace PASS, lint-fe PASS, build PASS (tsc + desktop/mobile/web bundles), vitest `--changed` 7008/7009 — the one failure was `pdf/PdfZoomRaster.test.tsx` "re-arms the commit on every tick" (sleep-timed, under parallel load); passes alone (5/5).
- Full `npx vitest run`: **846 files, 8575 tests, all passed**.
- `npm run mobile:bundle`: built (stamped sw.js checked).
- No Rust touched. Not run live.

## Hot-file rows for the main agent
- `docs/filemap_frontend.md`: add `mobile-web/src/pushTitles.ts` — "Push fallback titles for sw.js: build-stamped five-language table (`stampServiceWorker`) + the page's language kept in Cache Storage for the worker."
- `src/lib/untested.ts`: suggested row `phone-push-title-language` — "Phone push without details titled in the phone's language" (no pill surface exists; register-only, or skip at your discretion).

## Click-through (desktop + phone)
1. Settings → Language → Deutsch. Hover the header CPU / RAM / GPU readout: titles in German; GPU tooltip "… % ausgelastet", "Geteilt", "Ollama-Modelle: …", values aligned.
2. Settings → 12-hour clock, language Español: calendar day view shows "9:00 a. m."; the long date header is Spanish.
3. Switch to a remote (SSH) project: the switch toast reads "local … / remoto …" in Spanish.
4. Open an ssh login that needs a password: toast "<label> — autentícate en el terminal raíz".
5. Browser client (web): trigger a confirm (e.g. delete something) → buttons in the app language; confirming still works.
6. Phone: pick Deutsch in the phone's language picker; in push settings choose "Only that something wants you"; let an agent ask a question → notification titled "Ein Agent braucht deine Antwort". Switch phone to Italiano → next push in Italian.

## Flagged for user
- English dialog default label changes from "Ok" to "OK" (the shared `common.ok`).
- The `clientAdapters` error texts are now lowercase sentences without the `open_in_file_manager:` prefix.
- Push titles: if the page never ran since the update, the worker uses the browser language.

---

## Handoff — M2 (native dialogs), screen 2026-10-15 medium plan

Worktree `.claude/worktrees/med-m2`, branch `screen-med-m2`, from develop `2f0569c5`.

## Commits
- `ab755185` fix(dialogs): no native window.confirm/prompt/alert left in the app — all code + tests.
- `bedf848b` chore(i18n): M2 keys (main agent re-applies) — **drop this and re-apply the keys below in M1's i18n.ts** (it only touches `src/lib/i18n.ts` + `src/lib/i18nDicts/{de,es,fr,it}.ts`, 3 lines each, each inserted right after the named neighbour key).

## i18n keys to add (EN holds every key)
| key | after | en | de | es | fr | it |
|---|---|---|---|---|---|---|
| `deckView.removeSlideHeading` | `deckView.removeSlideConfirm` | Remove slide {n} | Folie {n} entfernen | Eliminar la diapositiva {n} | Retirer la diapositive {n} | Rimuovi la diapositiva {n} |
| `imageAnnotator.annotationTextTitle` | `imageAnnotator.annotationTextPrompt` | Add text | Text hinzufügen | Añadir texto | Ajouter du texte | Aggiungi testo |
| `remoteMachines.pullConfirmTitle` | `remoteMachines.pullConfirm` | Pull outputs | Ausgaben holen | Extraer resultados | Récupérer les sorties | Recupera output |

Tests reference new keys only through `translate("en", key)` (ImageAnnotatorTextPrompt); no test depends on their wording. Everything else reuses existing keys.

## What changed (28 sites; ProjectPill's 2 alerts are M3's)
Desktop → `useDialogs()` (`src/components/common/PromptDialogs.tsx`):
- `header/MobileIndicator.tsx` lockdown; `mobile/MobileSettings.tsx` set-up-in-terminal, lockdown, forget-all (+ per-device Revoke now `.catch`es and reports `status:"error"` — the M3 item M2 owned); `mobile/MobileSetupGuide.tsx` set-up-in-terminal.
- `skills/SkillsLibraryView.tsx` ×3; `embed/deck/DeckView.tsx` remove slide (async; re-checks the slide still exists after the answer); `embed/ImageAnnotator.tsx` text tool (promptText; overlay's capture-phase Escape stands down while asking); `mail/MailPane.tsx` empty priority list (captures the list asked about); `todo/TodoBoard.tsx` add/delete column (writes against the latest columns via a ref, not the pre-question closure); `todo/TodoCardDialog.tsx` delete; `projects/RemoteMachinesWindow.tsx:618` pull outputs (`{dialogs}` mounted inside the dialog box, no reindent — M4d's region untouched); `projects/BoxEditorDialog.tsx` + `layout/ProjectSwitcher.tsx` dissolve (one exported `dissolveBoxSpec`); `layout/DetachedCenterPanel.tsx` :2009/:2058/:2107 rename tab / new group / rename group, worded as TabBar's (hook added at the top of the component next to `t`, not near M3's :328 listen region).
Phone → sheets:
- New `mobile-web/src/components/ConfirmSheet.tsx`: `ConfirmSheet` (moved from `screens/Calendar.tsx`, `note` now optional, `run` may be sync) + new `NameSheet` (text field + one option; disabled while empty/unchanged; Enter submits).
- `screens/Todo.tsx` add/rename/delete column + delete card; `screens/Terminal.tsx` Interrupt key → `ConfirmSheet`.
- `api.ts` `openOutside()` returns `"opened" | "host_outdated"` instead of `window.alert`; `components/OutboxViewer.tsx` (its only caller) shows `mobile.open.hostOutdated` in its existing `role="alert"` line.

Shared-component choices (PromptDialogs, small):
- `DialogShell` auto-elevates (`modal-backdrop-elevated`) when the top modal at open time sits on an elevated backdrop — otherwise TodoCardDialog's question opened *under* the card (110 vs 100).
- `DialogShell`'s backdrop `onMouseDown` now `stopPropagation()`s: a portal still bubbles through React's tree, so a click outside the question reached hosts' `onMouseDown={onClose}` backdrops (BoxEditor, RemoteMachines, MobileSetupGuide) and the header's `handleDrag` (window drag) for the header-mounted ones. Keydown still bubbles by design (useModalFocus listens on document), so `{dialogs}` is mounted beside any host whose `onKeyDown` closes on Escape (TodoCardDialog → fragment). Doc comment on `useDialogs` says so.

Scan test `src/__tests__/shell/NoNativeDialogs.test.ts`: walks `src/` + `mobile-web/src/` (no tests), strips comments + quoted strings, flags `window|globalThis|self .confirm/prompt/alert(` and bare calls in files that don't bind the name (import / local / destructured). Exempt: `src/lib/transport/dialogAdapter.ts`. **`PENDING` = `{ "src/components/projects/ProjectPill.tsx": 2 }` (bare `alert(`) — M3 must delete that entry when it replaces the alerts; a companion test fails if the entry outlives them.**

## Gates
- `scripts/gates.sh`: brand PASS, whitespace PASS, lint-fe PASS, build PASS (tsc + bundles), Rust skipped (no Rust change). Its `vitest --changed` run had 1 flake: `MobileIndicator.test.tsx` "lists paired devices…" (`getByText("iPad")` after a revoke) under full load; passes 3/3 alone and in the full run.
- Full `npx vitest run`: **851 files, 8583 tests passed** (18 of them new).
- `npm run mobile:bundle`: exit 0. (Post-commit hook notes the embedded PWA in the running window is stale — expected, not acted on.)
- Not run live.

## Tests added / changed
- New: `shell/NoNativeDialogs.test.ts` (4), `todo/TodoNativeDialogs.test.tsx` (6: card delete rides elevated, Escape/backdrop dismiss only the question; board add/delete column + cancel), `mobile/MobileTodoSheets.test.tsx` (4), `viewers/ImageAnnotatorTextPrompt.test.tsx` (2: draws typed text; Escape cancels the prompt, not the annotator), `windows/DetachedRenamePrompt.test.tsx` (2).
- Updated from `spyOn(window,"confirm"/"alert")` to answering the dialog: `MobileSetupGuide`, `MobileTailscaleSetupOverlay`, `MobileProjectUploadsGate`, `MobileProjectFiles` (host-outdated now inline), `projects/BoxUx`.

## Rows for main agent
- Filemap (frontend), one line: `mobile-web/src/components/ConfirmSheet.tsx` — the phone's second-tap `ConfirmSheet` and name-prompt `NameSheet` on `OptionSheet`; replaces `window.confirm/prompt` (Calendar, Todo, Terminal Interrupt).
- `untested.ts`: none added — every site is an existing feature re-asked in shared chrome. If you want pills: `todo.nameSheet` (phone column name sheet) is the only genuinely new UI.

## Click-through (desktop, frozen dev build)
1. Header phone icon (Mobile on) → Lock down now → app dialog (not "localhost says"); click outside it → only the question closes, window does not start dragging; Cancel → nothing happens.
2. Mobile off → phone icon → guide → Set up in terminal → question over the guide; Cancel keeps guide; confirm opens root terminal.
3. Settings → Mobile: Set up in terminal / Lock down now / Forget all devices each ask in-app; Revoke on a device that fails shows an error.
4. Skills library: remove source, reinstall installed skill, uninstall.
5. Deck: remove a slide with layers → "Remove slide N" dialog.
6. Image → Annotate → Text tool → click canvas → "Add text" prompt; Escape closes only the prompt; Escape again closes the annotator.
7. Mail → Urgent list → Empty this list → dialog.
8. To-do overlay: + Add a column (prompt); × on a column (confirm); open a card → Delete → question appears **above** the card; Escape cancels only the question.
9. Remote machines window → worker → Pull outputs… → dialog with size.
10. Box editor → Dissolve; box chip right-click → Delete → same question.
11. Popout window: right-click a tab → Rename / New tab group…; right-click a group chip → Rename group… — dialog inside the popout.
Phone (after `npm run mobile:bundle` + rebuild/relaunch): To-do + Column, ✎ / × on a column, card Delete; terminal keys → Interrupt → sheet; a host too old for open tickets → message inline in the viewer.

## Flagged for user
- Phone `NameSheet` is a new small UI shape (field above a one-option sheet) — check it reads right on a phone.
- `DialogShell` backdrop now swallows the press (global to every `useDialogs` question) — deliberate; only visible effect is that hosts no longer close/drag on a click outside the question.
- MobileIndicator test flake under load (pre-existing timing, not touched by this diff).

---

## Handoff — M3 (hooks/state), branch `screen-med-m3`

Worktree `.claude/worktrees/med-m3`, from develop `2f0569c5`.

## Commits
- `91a9a951` fix(stores): M3 store/hook races and silent failures (code + 4 new test files)
- `925bca44` chore(i18n): M3 keys (main agent re-applies) — i18n.ts + de/es/fr/it only; drop at merge and re-apply the keys below in M1's i18n.ts

## What changed (per plan item)
- `DetachedCenterPanel.tsx` ~:328 (listen region only): the `agent-schedules-changed` listen now goes through the existing `subscribeTauri` (`hooks/useTauriListener.ts`), so a cleanup that runs before `listen` settles still unlistens. New import line for `subscribeTauri` near the `useWindowFocused` import (top of file, not M2's region).
- `stores/tabs.ts` (outside M7's AGENT_CMDS/RESUMABLE_AGENTS region):
  - New module helper `forgetClosedTab(scope, key)` = `purgeForTab` + `forgetPty` + `forgetPromptTrail`. Used by `closeHiddenGroup`, `closeGroup` (sibling with the same gap — it also skipped forgetPty), and `applyDetachedEdit` `case "close"` (run after `set`, only when the key was really in the popout).
  - `persistScope` non-strict catch: once per session (module flag `layoutPersistFailureReported`) sets new state `layoutPersistNotice` (+ `clearLayoutPersistNotice`) and `console.warn`s. AppShell forwards it into `useProjectsStore.connToast` (tabs.ts cannot import projects.ts — projects imports tabs; no new cycle).
  - `retargetTabs`, `setTabTmuxName` now return `writeScope(...)` (setTabTmuxName returns `{}` for an unknown key).
  - `attachGroup` reads `entries`/`entry` inside `set` from `s`; the backend `attach_subwindow` uses the entry actually docked.
  - `deserializeTree` checks each node via new `isSavedLayoutNode` (group: tabKeys string[]; split: dir row|column, children[], sizes[]); unusable sizes → even split; `filesWidth`/`filesFolder` type-checked. A malformed root → null → existing "one group with every tab" fallback.
  - New exported typed guards: `isSavedTabEntry`, `restorableSavedTabs(raw: unknown)`, `savedLayoutTreeOf(raw: unknown)`. `hydrateScopeFromDisk` uses them (behaviour identical for well-formed data).
  - `saveLayout` doc updated (AppShell no longer calls it).
- `AppShell.tsx`: quit flush → `persistScope(activeId, localFile)` (scope named explicitly); new effect forwarding `layoutPersistNotice` to the conn toast.
- `stores/projects.ts` (listener `listenProjectRuntimeSwitched` only, ~:1865-1915): side-panel folder restore moved before the disconnected-remote early return; the restorable filter now uses `restorableSavedTabs`/`savedLayoutTreeOf` (removes a third drifting copy); dropped now-unused `cmdToKind`/`isRestorableTab` imports (import block at top — M1 should not conflict, but note it).
- `wsClient.ts`: new exported `helloCapabilities(raw, protocol)`; `ServerCapabilities.hostOs` is now optional. Missing/malformed → `{protocol, role: "user", commands: []}` (unknown role never reads as admin). `installWeb.ts` sets `__APP_HOST_OS__` only when present (platform.ts falls back to the local OS).
- `useModelsHub.ts`: `pause_ollama_pull` `.catch` → `setError(t("localModel.pauseFailed"))`.
- `ProjectPill.tsx` (adopt in-folder layout, ~:2266-2300): invoke typed `unknown`, guarded by `restorableSavedTabs`/`savedLayoutTreeOf` (no `as never` ×4; also now weighs `resumeArgs`/`localLaunch`/`files` type like the other restores). **Both `alert`s replaced by `showMessage` from the component's existing `useDialogs()`** — so M2's `NoNativeDialogs.test.ts` `PENDING = { "ProjectPill.tsx": 2 }` entry can be dropped at merge.

## i18n keys to add (main agent; English + de/es/fr/it)
| key | en | de | es | fr | it |
|---|---|---|---|---|---|
| `appShell.layoutSaveFailedToast` (after `appShell.vpnStillActiveTitle`) | Couldn't save the tab layout — tabs opened or closed since may not come back after a restart. | Das Tab-Layout konnte nicht gespeichert werden — seitdem geöffnete oder geschlossene Tabs kommen nach einem Neustart eventuell nicht zurück. | No se pudo guardar el diseño de pestañas: las pestañas abiertas o cerradas desde entonces quizá no vuelvan tras reiniciar. | Impossible d'enregistrer la disposition des onglets — les onglets ouverts ou fermés depuis pourraient ne pas revenir après un redémarrage. | Impossibile salvare il layout delle schede: le schede aperte o chiuse da allora potrebbero non tornare dopo un riavvio. |
| `localModel.pauseFailed` (after `localModel.updateFailed`) | Couldn't pause the download | Der Download konnte nicht pausiert werden | No se pudo pausar la descarga | Impossible de mettre le téléchargement en pause | Impossibile mettere in pausa il download |
| `pill.adoptFolderLayoutTitle` (after `pill.adoptFolderLayoutNone`) | Restore layout from folder | Layout aus dem Ordner wiederherstellen | Restaurar el diseño de la carpeta | Restaurer la disposition du dossier | Ripristina il layout dalla cartella |

## Tests (regression per fix)
- `src/__tests__/windows/DetachedSchedulesListener.test.tsx` — listener disposed when listen resolves after unmount, and after a `tabs` change.
- `src/__tests__/tabs/TabStoreCloseAndRestoreGuards.test.ts` — closeHiddenGroup/closeGroup/popout close forget PTY state; persist failure notice once per session (strict still throws); malformed trees/records rejected (6 shapes + malformed child + bad sizes); guards; attachGroup; writeScope payload writes.
- `src/__tests__/projects/RuntimeSwitchSidePanelFolder.test.ts` — folder restored for a disconnected remote, tabs deferred.
- `src/__tests__/shell/WsHelloCapabilities.test.ts` — hello without capabilities → ready, user role, no hostOs; unknown role never admin.
- In-folder layout typed guard: covered by the guard tests (no ProjectPill component test).

## Gates
- `scripts/gates.sh`: brand, whitespace, lint-fe, build PASS; vitest --changed PASS; Rust gates skipped (no Rust change).
- Full `npx vitest run`: **8590 passed (8590)**.
- eslint on the touched files: no warnings.

## Gotchas
- `isSavedTabEntry` allows a missing `key` (backend `#[serde(default)]`; root-restore fixtures omit it) — first run failed 4 root tests until relaxed.
- `layoutPersistNotice` is new TabsStore state; tests that `setState` a full store aren't affected (optional read).
- Narrowing: vars assigned inside `set` callbacks use `null as T | null` casts (TS can't see the assignment).

## Click-through (not run live)
1. Popout a group with a Claude tab that has a schedule; close the popout window quickly after opening it a few times — no stray refresh after close (hard to observe; mainly a leak fix).
2. Hide a subwindow (side panel → Hidden), then ✕ it in the Hidden list: its terminals end (`ps` shows the shells gone) and a new tab doesn't show a stale half-typed prompt count.
3. Make the state dir read-only (or break `workspace_sync`) and open/close a few tabs: exactly one toast "Couldn't save the tab layout…", not one per change.
4. Quit with a Files tab navigated into a subfolder, relaunch: the tab reopens in that subfolder.
5. Remote project with SSH down: switch to it — side panel shows the last browsed folder; tabs restore after reconnect.
6. Project pill → "Restore layout saved in the folder…": result shows in the app's dialog (not a browser alert), both with and without a folder layout.
7. Settings → Local models: pausing a download when the backend refuses shows "Couldn't pause the download".
8. Browser client against an older daemon (hello without capabilities): page boots.

## Flagged for user
- Layout-save failure notice is once per *session* (never re-armed after a later success), per decision #7's wording.
- The runtime-switch restore filter in `projects.ts` now also treats a `type: "files"` record with empty `cmd` as a Files tab (as `hydrateScopeFromDisk` already did) — consolidation, not a decision change.
- No `UntestedTag` added: no new feature, only fixes (ProjectPill's button already carries `projectPill.17`).

## Review — M3

Reviewed `git diff 2f0569c5..screen-med-m3` (91a9a951 code, 925bca44 i18n).
Fix commit: **`95694d50`** (on top of 925bca44; code only, no i18n).

### Fixed (each with a regression test that fails on the pre-fix code)
1. **Quit flush lost an open box's last change (regression from the M3
   switch).** With a box open the tab store's scope is `box:<id>` while
   `activeId` stays the project; the new quit flush persisted the project
   scope (nothing pending) and dropped the box's ≤300 ms debounced change
   (before M3 it flushed the box, though with the project's `local_file`).
   New exported `activeLayoutPersistTarget(scope, activeId, localFile)` in
   `stores/tabs.ts` — box → `(box:<id>, "")`, project → `(id, its
   local_file)`, none → `("root", "")`, project without a file → null — used
   by both CenterPanel's debounced save and AppShell's quit flush (one rule;
   root is now flushed at quit too). Tests: `AppShellClose.test.tsx` "flushes
   an open box's own scope on quit…", and the helper's cases in
   `TabStoreCloseAndRestoreGuards.test.ts`.
2. **`closeDetachedGroup` still skipped the shared close cleanup** (purged
   link routes but not `forgetPty`/`forgetPromptTrail`) — the popout's WM ×
   and DETACHED_CLOSE path. Now calls `forgetClosedTab`. Test:
   "closeDetachedGroup (a popout's WM ×) forgets every closed tab's PTY".

### Checked, no bug
- `forgetClosedTab` only clears JS-side state (link routes, pending-prompt
  flag, prompt trail); it never kills a PTY, so no move path
  (detach/dock/hide/`move`/`split` edits, `dropDetachedGroup`,
  `hideDetachedGroup`) can lose a live terminal through it; it runs only on
  `closeGroup`, `closeHiddenGroup`, a popout `close` edit that really held the
  key, and now `closeDetachedGroup`. `close` edits are sent only for real
  closes (× / sweep / file deletion), never for drags. Remaining close paths
  (`removeTab`, `removeTabInScope`, `closeAllTabs`, `unloadScope`,
  `closeTabsOfKinds`) already did all three steps inline.
- New popout `close` comment ("the main window's flat pane layer unmounts its
  spawning pane") is correct: CenterPanel renders every tab including popout
  ones (`inPopout`), and its TerminalView owns spawn/kill.
- `persistScope` notice: module flag set before `set`, so no loop; the
  notice is outside CenterPanel's persist deps; quit path `.catch`es. Backend
  `workspace_sync` errs only on I/O/lock failures, so no benign refusal trips it.
- `writeScope` routing in `retargetTabs`/`setTabTmuxName`: same scope read
  from `s`, layout/focus identity kept when unchanged, no extra persist.
- `attachGroup`: reads entry inside `set`; second dock is a no-op without
  `attach_subwindow`.
- Typed guards: `SavedLayoutTree` shape unchanged since the first Tauri
  commit (`b335948c`); `TabEntry` label/cmd/cwd are non-optional `String`s in
  Rust, so every on-disk record passes; Python-era `type:"files"` + empty
  `cmd` still restores. In-folder adopt is already sanitized backend-side
  (`sanitize_untrusted_layout`: env/embedExec/localLaunch/scheduleTarget
  dropped); the guards add type checks only.
- Side-panel folder before the disconnected-remote return: it is a stored
  path; the panel was already listing the root for that project before.
- `helloCapabilities`: nothing client-side reads `role`/`commands` (server
  enforces), missing `hostOs` falls back to the local OS — degraded boot is
  usable and grants nothing.
- `subscribeTauri` in DetachedCenterPanel: correct dispose-before-settle.

### Flagged for user / coordinator
- **Cross-step (M4a, not M3):** M4a classes `workspace_sync.localFile` as
  `LocalFile`, and `is_project_local_file("")` is false — so for a
  `Role::User` browser client every root- and box-scope save (they send
  `localFile: ""` by design) is refused. With M3 merged the user sees the
  layout-save toast once and those layouts never persist. M4a's reviewer
  should let an empty `localFile` through for `workspace_sync` (empty = no
  export copy) or treat it as `UserPathOpt`.
- `deserializeTree` accepts an all-zero `sizes` array (every entry ≥ 0, sum
  0 → `|| 1` → panes of size 0). Pre-existing, not produced by
  `serializeTree` in practice; requiring a positive sum would make it fall
  back to an even split. Not changed (doubtful it occurs).
- `applyDetachedEdit` and `closeDetachedGroup` still build `tabsByScope`
  patches by hand instead of `writeScope` (plan named only `retargetTabs`
  and `setTabTmuxName`); not changed.

### Gates (after 95694d50)
- `scripts/gates.sh`: brand, whitespace, lint-fe, build, vitest --changed
  PASS; Rust gates skipped (no Rust change).
- Full `npx vitest run`: **8594 passed (8594)** (8590 + 4 new).
- eslint on the touched files: clean.

---

## Handoff M4a — browser-client path confinement (fixed decision #6)

Branch `screen-med-m4a` (worktree `.claude/worktrees/med-m4a`), from develop `2f0569c5`.
Commit: `6e8ae492` (one commit, author noreply; pre-commit/privacy hooks ran).

## What changed

- `src-tauri/src/services/core_dispatch.rs` — `USER_CONFINED_PATH` replaced by
  one typed table `USER_CONFINED: &[(cmd, key, Kind)]` checked in
  `confine_for_user` (after the class check and the model allowlist, before the
  wrapper; `Role::Admin` is never touched). Keys with a `.` name a field of a
  struct argument (`req.directory`, `target.dir`, `target.projectDir`).
  `user_path` (tickets/grants, picker) now requires an absolute path and holds
  it to `fs::user_roots`. Module doc updated.
- `src-tauri/src/commands/fs.rs` (helpers only) — `user_roots()` /
  `compute_user_roots()` = root work dir ∪ `paths::projects_root()` ∪
  `paths::projects_ssh_root()` ∪ every project `directory` ∪ every mirror
  override ∪ every box folder (relative entries dropped; each resolved via
  `canonical_or_new`). `confine_user_path` now uses it (was: current project +
  box siblings + root work dir), refuses relative paths, and answers
  "path '…' is not in the current project or any other of your projects".
  `is_project_local_file()` for `LocalFile`. `PROJECTS`/`BOXES` state caches
  moved to module statics (shared by `allowed_roots` and `user_roots`).
- `src-tauri/build.rs` — the generator also emits `arg_keys(cmd) ->
  Option<&[&str]>` (each wrapper's JSON keys, cfg-gated like `handler`;
  `#[allow(dead_code)]`, read only by the coverage test).
- `src-tauri/src/services/mobile_control/web_client.rs` — module doc (what a
  user is confined by now) and the user-session test gains `list_dir`
  `projectDir: "/"` and `git_status` with a foreign `projectDir` (both refused).
- `docs/context/web_client.md` — the "file picker browses the server" bullet no
  longer says `list_dirs`/`list_dir_all` are unconfined for a user; new bullet
  "A user account's paths are held at the dispatcher".

## The final table (kinds)

- `Picker` (empty → root work dir): `list_dir_all.path`, `list_dirs.path`.
- `UserPath` (absolute, inside user roots; null = absent; empty/relative refused):
  `calendar_read_ics.path`, `calendar_write_ics.path`, `compile_tex.path`,
  `exec_trust_approve.dir`, `export_project.req.destPath`, `git_clone.dest`,
  `git_fork_clone.dest`, `git_merge_sides.path`, `import_external_file.sourcePath`,
  `import_project_export.req.bundlePath`, `inspect_project_export.bundlePath`,
  `move_remote_mirror.parentDir`, `preview_project_scaffold.sourceDir`,
  `project_folder_exists.directory`, `remote_download_to.destDir`,
  `remote_upload_file.localPath`, `resolve_tex_root.path`,
  `set_remote_mirror_dir.path`, `skills_{install,list_installed,uninstall}.target.dir`,
  `tex_auto_engine.path`, `tex_preview_snippet.dir`, `watch_dir.path`.
- `UserPathOpt` (as UserPath; empty → null): `watch_dir.repoDir`,
  `import_project_export.req.{targetParent,mirrorParent}`,
  `create_project.req.mirrorParent`, `import_project.req.mirrorParent`.
- `OutDirOf("path")`: `compile_tex.outDir` — relative is taken against the
  source file's folder (as the body does), then held; empty → null.
- `LocalUnlessRemote("projectId")`: `disk_usage_scan.root` — a host path when
  `projectId` is a remote project's (the body walks it over SSH), else held.
- `Hint` (outside the roots → dropped to null, not refused):
  `format_source.path`, `formatter_available.path` (only says where to look for
  prettier/config; a remote file's host path must not fail Format).
- `LocalSite`: `create_project.req.directory`, `import_project.req.sourceDir` —
  held unless the request has a non-null `remote` or `vm.enabled == true`
  (then the body ignores it and uses the state dir). Without it a user could
  register `/` as a project and widen their own roots.
- `ProjectDir`: every `projectDir` (fs, git_* incl. `git_worktree_*`, slurm_*,
  python_*, project_search, project_generated_dir, list_project_*,
  usage_git_stats, hpc_ws_link, import_external_file, update_gitignore_rule,
  rename_path, extract_archive, …), `copy_path`/`move_path`
  `srcProjectDir`+`destProjectDir`, and `hpc_*`'s `target.projectDir`
  (`HpcWsTarget`: a login node runs the script in that folder).
- `LocalFile` (must be a known project's `local_file`, by spelling or
  canonical path): `adopt_folder_tab_layout`, `get_project_panel_prefs`,
  `set_project_panel_prefs`, `load_project`, `load_side_panel_folder`,
  `save_side_panel_folder`, `workspace_sync`.
- `BodyConfined` (verified): `read_file_text`, `write_file_text`, `file_mtime`,
  `file_size`, `detect_mime` (`open_confined`/`confine_abs_read`, remote →
  `confine_remote_abs`), `file_source` (no fs access), `sqlite_tables`,
  `sqlite_page` (`sqlite::confine`), `read_spreadsheet`
  (`confine_project_path`), `copilot_complete` (`authorize_document` under the
  project root), `pdf_markup_submit` (`resolve_local_source`),
  `markup_mcp_list/ticks.path` (`resolve_file` under the project, else
  "elsewhere"); every `relPath`/`destRel`/`destName` under a held `ProjectDir`
  (`enforce_confinement`; git pathspecs); `git_worktree_add.path`
  (`resolve_worktree_path`, lexical containment under the worktrees root) and
  `git_worktree_{remove,lock,unlock}.path` (git acts only on its listed worktrees).
- `Remote`: `ssh_list_dir.path`, `ssh_mkdir.path`, `remote_remember_path.path`,
  `remote_set_default_path.path`, `hpc_ws_anchor.{workspacePath,mirrorPath}`,
  `hpc_ws_link.workspacePath`, `hpc_ws_move_root.newRoot`,
  `hpc_ws_pull_logs.logsDir`, `slurm_job_out.logDir`,
  `remote_download_size.relPath`, `remote_download_to.relPath`,
  `remote_upload_file.destRel`, every `sync_*` `relPath(s)`.
- `Refuse`: `ollama_models_dir_plan.path` (whole command, user only).
- `NotAPath`: `agent_schedule*`/`markup_mcp_*` `scheduleTargetId`;
  `agent_tab_{changes,transcript}.tabDir` and `claude_folder_trusted.cwd`
  (lookup keys into a CLI's session store / trust list, never opened; a remote
  tab's are host paths); `localModel`/`localOnly`/`isDir`/`ownFolderUnlinked`
  flags; `caldav_*` `resourceHref`; mail `folderId`/`destFolderId`;
  `credential_paste_to_pty.target`; `git_checkout.target` and
  `git_peer_checkout.target` (refs); `hpc_ws_{extend,release}.filesystem`;
  `set_project_git_hosting.profileUrl`; `set_project_sandbox.sourceDecision`;
  `skills_*` `sourceId`/`relPath` (catalog); `sync_transfer_preview.direction`;
  `save_side_panel_folder.folder` (a project-relative view setting, stored only).

Every held value is checked **as the body will read it**: a value with
leading/trailing whitespace is rewritten trimmed before the check (some bodies
trim — `compile_tex` would have turned a vouched-for relative ` /` into `/`).

## Choices / deviations from the plan's table

- Plan listed as `UserPath`, moved after reading the bodies:
  `agent_tab_*.tabDir`, `claude_folder_trusted.cwd` → `NotAPath` (lookup keys;
  holding them would break transcripts/trust checks of remote tabs);
  `hpc_ws_pull_logs.logsDir` → `Remote` (read over SFTP);
  `format_source`/`formatter_available` `.path` → `Hint` (dropped, not refused);
  `disk_usage_scan.root` → `LocalUnlessRemote` (the pane passes a host root with
  `projectId` for a remote project); `git_worktree_add.path` → `BodyConfined`
  (already contained under the worktrees root of the held `projectDir`).
- Added beyond the plan's key list (struct fields the key regex cannot see):
  `create_project.req.{directory,mirrorParent}`,
  `import_project.req.{sourceDir,mirrorParent}`, `export_project.req.destPath`,
  `import_project_export.req.{bundlePath,targetParent,mirrorParent}`,
  `hpc_*.target.projectDir`, `skills_*.target.dir`.
- `save_projects` checked: it only copies `status`/`position`/`box_id`, never a
  directory — no row needed.
- `user_roots` also includes `paths::projects_ssh_root()` (default parent of
  new remote mirrors; the plan named only the projects root).
- `user_path` / tickets / grants now use `user_roots` (all the user's projects),
  not just the current project + box siblings — per the plan.
- `run_script_detached`, `read_file_bytes`, `write_file_bytes` have no wrapper
  (KNOWN_GAPS), so no rows; the binary-frame `read/write_file_bytes` go through
  the bodies' own `open_confined`.

## Tests (all in `cargo test -p tabtivity --lib`)

core_dispatch: `a_users_absolute_paths_are_held_to_their_roots`,
`a_users_optional_paths_are_held_and_empty_is_absent`,
`a_users_scan_root_is_held_unless_it_is_a_remote_projects`,
`a_users_hint_path_outside_their_roots_is_dropped`,
`a_users_output_folder_is_taken_against_its_source`,
`a_users_new_project_folder_is_held_unless_the_site_is_remote`,
`a_users_project_folder_is_held_to_their_roots`,
`a_users_local_file_must_be_a_known_projects`,
`a_refused_command_is_refused_for_a_user_only`,
`body_confined_remote_and_non_path_arguments_pass_untouched`,
`a_users_project_dir_of_root_never_reaches_the_body` (through `dispatch`),
`every_path_named_core_argument_is_classified` (coverage: walks
`dispatchable_names()` × `arg_keys()` for `core` commands, keys matching
path|dir|file|folder|dest|root|cwd|source|target|local case-insensitively;
also fails on stale/duplicate rows and rows naming a non-core command or a
missing argument). Each kind's test passes `/` (`C:\` on Windows), a foreign
tempdir and a relative path as a user (refused) and as an admin (untouched).
fs: `user_roots_cover_every_project_mirror_box_folder_and_base_and_nothing_else`,
`a_local_file_must_be_a_known_projects`. web_client:
`a_user_session_is_confined_and_denied_admin_commands` (+ ids 6, 7).

## Gates

`scripts/gates.sh` (selection: src-tauri) — all PASS: brand, whitespace,
clippy (`-p tabtivity -p app-serverd --all-targets -D warnings`), clippy-dlib
(`--no-default-features --lib`), clippy-dmn, test (`-p tabtivity -p
app-serverd`, full suites, 0 failures), test-dlib (`--no-default-features
--lib --test server_secrets`). Frontend gates skipped (no frontend change).
Targeted: `cargo test -p tabtivity --lib -- core_dispatch user_roots
a_local_file_must web_client` → 38 passed. (Per-gate test counts were not
kept: the gate log dir was reaped.)

Cross-checks (shims present in `~/.local/bin`): Windows msvc
`cargo clippy --manifest-path src-tauri/Cargo.toml --target
x86_64-pc-windows-msvc --all-targets -- -D warnings` PASS; `cargo check
--workspace --all-targets` for `x86_64-pc-windows-msvc` PASS and for
`aarch64-apple-darwin` (check-only CC/AR stand-ins) PASS. Tests are
cross-OS: outside paths use `C:\` on Windows, every other path is built
from a tempdir or `root_work_dir()` with `Path::join`.

## What M4d must know (web_client.rs / ctx)

- M4a did **not** touch `CoreCtx`, `src-core`, or how the role flows. In
  `web_client.rs` it changed only the module doc paragraph "Who the caller
  is" (~:50-57) and the test `a_user_session_is_confined_and_denied_admin_commands`
  (two more calls, ids 6/7; the loop asserts every ret 1.. is an error string
  containing "not in the current project"). `handed_out_path` is unchanged and
  still calls `core_dispatch::user_path`.
- `confine_for_user(role, cmd, &mut args)` is private in `core_dispatch` and
  runs inside `dispatch(ctx, role, cmd, args)`; the role is still a separate
  parameter, not in the ctx. If M4d moves the role into `CoreCtx`, keep
  `dispatch`'s order: class → feature → model allowlist → `confine_for_user` →
  wrapper.
- The `LocalSite` rule reads `req.remote`/`req.vm.enabled` from the raw JSON;
  M4d's provenance stamping on `create_project`/`import_project` is unaffected.

## Flagged for user / other steps

- **M5 (command classes):** `ollama_models_dir_plan` is classed `core` but plans
  the server-wide Ollama models dir; M4a refuses it for `Role::User` in the
  table. Suggest reclassing it `admin` in a class review (then drop its
  `Refuse` row — the coverage test would flag the row as "not a core command").
  No command added/removed, no class changed.
- **Filemaps (rows for the merger):** `docs/filemap_backend.md` `core_dispatch.rs`
  row still says "`confine_for_user` (`USER_CONFINED_PATH`: a user's
  `list_dir_all` is held to their roots, `user_path`)" → replace with
  "`confine_for_user` (`USER_CONFINED`: every path-named argument of a `core`
  command classified — held to `fs::user_roots`, project folder, `project.json`,
  body-confined, remote, refused or not a path; a coverage test fails on an
  unclassified one)". The `mobile_control/` row's web_client sentence "a user's
  `list_dir_all`, tickets and grants are confined to their roots
  (`core_dispatch::user_path`)" → "a user's path arguments (`core_dispatch`'s
  table), tickets and grants are held to their roots". `build.rs` emits
  `arg_keys` now (hosted_handoff.md :601 lists the generator's outputs —
  history doc, left alone).
- Behaviour change for user accounts (not admins, not the desktop): local
  paths outside every project/box/work folder are refused everywhere —
  e.g. a disk-usage scan of `/` or `$HOME`, cloning into `~/src`, importing a
  folder outside the projects root, `list_dirs` of `$HOME` (empty start is now
  the root work dir, up-navigation past the roots is refused). Intended by #6;
  worth a line in the server docs if users ask.
- Not run live (no server/daemon session started).

---

## M4a security review — findings (finder)

Branch `screen-med-m4a` @ 6e8ae492, worktree `.claude/worktrees/med-m4a`.
I reviewed the diff against the code, checked all 562 dispatchable `core` commands' argument keys (from the build's `OUT_DIR/core_dispatch.rs` `arg_keys()`, joined with `command_class`), and read the bodies of the suspicious ones.
`cargo test -p tabtivity --lib -- core_dispatch user_roots a_local_file_must`: 23 passed.
Line numbers refer to the worktree.

---

## Likely real

### 1. HIGH: `import_project` LocalSite bypass via an ignored `vm` field registers any folder as a project, which widens the user's roots
- `services/core_dispatch.rs` `confine_arg`, LocalSite branch (diff ~L405-411). It skips the hold when `req.vm.enabled == true`.
- `commands/projects.rs:4325` `ImportProjectRequest` has **no `vm` field**, and no `deny_unknown_fields`. serde drops the key, and `import_project_blocking` (L4360-4446) runs the plain local path.
- Scenario: a Role::User sends `import_project {req:{sourceDir:"/home/<user>", name:"x", mode:"keep", vm:{enabled:true}}}`. The dispatcher skips the hold, and the body registers `$HOME`, or any writable folder, as a local project. From then on `fs::user_roots()` contains that folder, so every `projectDir`, `UserPath` and ticket check passes for everything under it, including the state dir (`projects.json`, agent homes, credentials). The same works for `/tmp` and any other folder the uid can write (`finish_import` writes `project.json` there).
- Fix: make LocalSite per command. Only `create_project` honours `vm`; `import_project` honours only `remote`. Better: decide from the deserialised request type, so the check sees exactly what the body sees. Add a test with `import_project` + `vm:{enabled:true}` + an outside `sourceDir`.

### 2. HIGH: `skills_uninstall.name` is an unconfined path, so a user can delete any folder recursively
- `services/skills.rs:366-372`: `target_skills_dir(target)?.join(name)` and then `fs::remove_dir_all`, with no validation of `name`.
- The table holds only `target.dir`. `name` is not path-named, so it has no row and the coverage test is blind to it. `target: {kind:"personal"}` has no `dir` at all and passes the dispatcher.
- Scenario: `skills_uninstall {target:{kind:"personal"}, name:"../../.."}` runs `remove_dir_all(~/.claude/skills/../../..)`, which is `$HOME`. `name:"/srv/data"` (an absolute path replaces the base in `join`) deletes `/srv/data`. This is also reachable on the desktop by any compromised webview script.
- Fix: in the body, accept `name` only as a single `Normal` component (`validate_bare_name`-style), and refuse `.`, `..`, separators and absolute paths. In the table, add a `NotAPath` row for `name` with that reason, or a new `Leaf` kind that validates it.

### 3. HIGH: `skills_install` takes its destination from catalog-controlled `SKILL.md` frontmatter, deletes it recursively and then copies into it
- `services/skills.rs:347-362`: `name` comes from `parse_skill_md` (L178-196, the `name:` frontmatter, not sanitised). Then `dest = target_skills_dir(target)?.join(&name)`, `remove_dir_all(dest)` if it exists, and `copy_dir_recursive`.
- `skills_add_source(url)` is `core`, so a user can add any git repo. That repo, or a malicious upstream, ships `SKILL.md` with `name: ../../../..` or `name: /home/u/x`, and installing that skill wipes and overwrites an arbitrary folder. This is not only a user-role issue; it hits the desktop owner too.
- Same file: `relPath` and `sourceId` (classed `NotAPath`, "catalog path") go straight into `cache_dir(source_id).join(rel_path)` (L277, L348) with no validation. `skills_get_detail {sourceId:"x", relPath:"/home/u/.claude/skills/foo"}`, or `..` hops, reads `SKILL.md` and lists the file tree of any folder that contains a `SKILL.md`. `skills_install` with the same arguments copies that whole folder into a project. So reads escape the roots too.
- Fix: run the frontmatter `name` through `sanitize_name`/bare-name validation, and fall back to the folder name. Confine `rel_path` to lexical `Normal` components, then canonicalise and prefix-check it under `cache_dir`. Validate `source_id` as a single component. Reclassify `relPath`/`sourceId` from `NotAPath` to something honest (`BodyConfined`, once the body actually confines).

### 4. MEDIUM, legitimate-flow break (coordinator-relayed, verified): `workspace_sync` with an empty `localFile` is refused for users, so root and box layouts never persist
- `confine_arg`: `LocalFile` with `""` reaches `is_project_local_file("")`, which returns false, and the call fails with "'' is not the file of any of your projects". Only `null`/absent passes.
- The frontend always sends a string: `src/stores/tabs.ts:5351-5361` (the comment says the root scope has no project.json, "so `localFile` is empty and the backend simply skips the export copy"). `WorkspaceSyncPayload.localFile: string` is at L5546. The backend signature is `local_file: String` (`commands/projects.rs:2739`), so the frontend cannot send `null`.
- Effect: for every Role::User browser client, the root scope's and every box scope's tab layout save fails on every persist. With M3 merged, that is a visible save-failure toast as well.
- Other `LocalFile` callers guard against empty already: `projects.ts:1361`, `FileBrowser.tsx:97`, `load_side_panel_folder` with the current project's `local_file`.
- Fix: treat empty (after trimming) as "no path" and pass it through. Either add a `LocalFileOpt` kind used for `workspace_sync`, or let `LocalFile` accept empty for that row only. Confine only non-empty values. Add a user-role test: `workspace_sync` with `localFile:""` passes the dispatcher.

### 5. MEDIUM: root widening by a symlink swap — roots are canonicalised at check time, so a registered folder that later becomes a symlink to `/` makes `/` a root
- `commands/fs.rs` `compute_user_roots` (new): each project, mirror and box root goes through `canonical_or_new`, and `canonical_or_new` follows a symlink at the root itself.
- Scenario using only `core` commands (no shell):
  1. `git_clone` an attacker repo into `<root_work>/c`. Branch `a` has `p/` as a folder; branch `b` has `p -> /` as a symlink.
  2. Register `<root_work>/c/p` (`import_project` keep, or `create_project`). It is a real folder at that moment, so the hold passes.
  3. Remove the scaffold files with `delete_file`.
  4. Run `git_checkout projectDir=<root_work>/c target=b`. Git replaces the folder with the symlink.
  5. `user_roots()` now contains `/`, and every check passes.

  `set_remote_mirror_dir` and box folders behave the same way.
- Severity is tempered: a user also has `pty_spawn` (`ln -s`), and the plan calls M4a defence in depth. Still, the table is meant to hold even without the shell, and this defeats all of it at once.
- Fix options:
  - Never accept a root whose canonical form is an ancestor of, or equal to, `/`, `$HOME`, `app_home()` or the state dir.
  - Or keep a project/mirror/box root only if its canonical form equals its normalised lexical form, or lies under a base root's canonical form. That excludes roots redirected after registration.
  - Or record the canonical path at registration and compare against that.

---

## Speculative / lower severity

### 6. LOW-MEDIUM: unclassified path arguments the `PATH_NAMED` regex does not see (struct fields and odd names)
The coverage test checks only top-level keys whose names match the regex. Struct arguments whose key is not path-named (`req`, `opts`, `spec`, `bases`, `pdf`, `config`, `name`) are never looked at.
- `resolve_text_paths.bases` (`commands/fs.rs:157`): the bases are taken as given. `bases:["/"], candidates:["home/u/.ssh/id_ed25519"]` returns a FileEntry (exists, size, mtime, is_dir) for any path: a metadata oracle outside the roots. Fix: hold each base. That needs an array kind (`UserPathEach`), or the body could drop bases outside `user_roots` for users. The table has no array support today; only the `Remote` `relPaths` rows are arrays.
- `synctex_edit/status/view/page_lines.pdf` (`commands/synctex.rs:1276-1306`): reads and inflates `<pdf>.synctex(.gz)` beside any path, and `status` stats the sources it lists. This is a small read oracle. Fix: a `UserPath` row for `pdf`, if viewers only pass local or mirror paths. Verify the remote viewer first.
- `check_project_site.req.directory`: compare only (no fs use apart from conflict matching). It needs a `NotAPath` row only for honesty.
- `set_project_openvpn.config` (stored `.ovpn` path, later read by root `openvpn --config`; `--script-security 1` is pinned), `set_project_sandbox_spec.spec.dockerfile`, `set_project_python.interpreter`, `pty_spawn.opts.cwd`, `probe_binaries.bins`: exec/config paths. These are acceptable under "the user has a shell", but should be listed with that reason.
- Suggested test hardening: require a row (even `NotAPath` with a reason) for every argument of a `core` command whose Rust type is a struct or `Vec<String>`. build.rs can emit the parameter type next to the key. That also catches `skills_uninstall.name`-style leaf names if `name`/`leaf` are added to `PATH_NAMED` (`rename_project_dir.leaf`, `move_remote_mirror.name` and `global_inbox_delete.name` are already validated in their bodies).

### 7. LOW-MEDIUM: `SkillTarget::Personal` is outside the user's roots
`skills_install/uninstall/list_installed {target:{kind:"personal"}}` reads and writes `~/.claude/skills` in the user's real home, outside every root, and outside the agent-homes model. The table passes it because `target.dir` is absent. Fix: refuse `kind: personal` for Role::User (a row kind keyed on the variant), or map Personal to the Tabtivity-wide layer.

### 8. LOW: `GitWorktreeSelection.path` and repo-controlled git pointers lead out of a held `projectDir`
- `selected_git_context` (`commands/git.rs:3047-3080`) accepts any path that `git worktree list` reports. That list comes from `.git/worktrees/*/gitdir`, which a user can write with `write_project_file` (`.git/...` is not refused). Pointing it at another repo outside the roots (one with a `.git`, so it is not "prunable") makes `git_status/log/commit/checkout` run with `cwd` outside the roots.
- Likewise, a `.git` gitfile or `core.worktree` in `.git/config` (not neutralised by `HARDENED_CONFIG`; only bare repos are) redirects git outside the project.
- This is pre-existing body behaviour, and the plan classes `worktree` as exempt. Flagged because the plan's justification ("validated against the repo's own worktree list") relies on repo content the user controls.
- Fix: for users, hold the selected worktree's path with `confine_user_path` after the list lookup, and pin `core.worktree=` / refuse gitfile redirections outside the roots in the hardened config.

### 9. LOW: check-then-use TOCTOU
`confine_for_user` canonicalises at dispatch, and bodies later reopen by the original spelling (`git_clone.dest`, `calendar_write_ics.path`, `compile_tex.outDir`, `exec_trust_approve.dir`, …). A symlink swapped in between escapes. It needs a symlink creator (a shell, or the git route in #5), so it is low. Long-term fix: pass the canonical path the check produced to the body (rewrite the argument to the resolved path), as `write_confined` already does for project writes.

### 10. LOW: `OutDirOf` judges against the lexical parent, while the body uses the canonical parent
`confine_arg` joins a relative `outDir` to `Path::new(path).parent()`. `compile_tex_blocking` (`commands/tex.rs:1211-1259`) joins it to `fs::canonicalize(path).parent()`. When `path` is an in-root symlink to a file in another folder, the folder that was checked is not the folder that gets written. Both are normally inside the roots; it only escapes together with #5 or #9. Fix: canonicalise `path` in the check too, i.e. resolve the parent the same way the body does.

---

## Checked and OK
- Role determination: the token login is Admin only without the gateway. Behind the gateway the role comes from the gateway header on a `PeerGatedUnixListener` (SO_PEERCRED, the gateway's uid only; the user's own shells are refused), and a missing role means User. No path reaches `dispatch` with a forged role. Transport commands: `read_file_bytes`/`write_file_bytes` are confined by their bodies (`read_file_bytes_for`/`write_file_bytes_for`, scoped roots); tickets and grants go through `handed_out_path` → `user_path`.
- Generated wrappers read exactly the camelCase key (`arg()`), and the confined structs have no serde aliases, so there is no snake_case/alias side door. A duplicate JSON key collapses in `Value` before both the check and the body.
- The trim handling is consistent: the held, trimmed value is written back, so the body sees what was checked.
- `UserPathOpt`, `Hint`, `LocalUnlessRemote` (`disk_usage_scan` decides remoteness from the same untrimmed `projectId`), `Picker`, `Refuse` all look right. `hpc_ws_pull_logs.logsDir` is correctly `Remote` (SFTP source; writes go to the mirror, confined).
- `rename_project_dir.leaf` (`is_valid_folder_leaf`), `move_remote_mirror.name` (`sanitize_name`), `global_inbox_delete.name` (`valid_global_name`), `spell_*` `code` (`valid_code`), `import_external_file.destName` (`validate_import_name` + `enforce_confinement`) and `import_project_export` (leaf `sanitize_name`, parents held) are all validated.
- `save_projects` copies only status and position, and `save_boxes` is `Off`. `patch_box` cannot set a folder, and `ensure_box_folder` derives the folder from a sanitised name under `boxes_root`. So no registry write widens the roots except #1 and #5.
- URL commands (`browser_reader_fetch`, `calendar_fetch_ics`, `markdown_remote_image`) allow http(s) only. `git_clone` refuses `file://` and local paths (`validate_clone_url`).
- `..` anywhere is refused by `resolve_for_confinement`. Relative paths are refused. Windows `C:\` and UNC paths canonicalise outside the roots and are refused. On a case-insensitive filesystem a differently-cased, not-yet-existing tail fails closed (a false refusal, not a bypass).

---

## Verification — M4a

Verifier, branch `screen-med-m4a`. All fixes are in one commit, **30c02942** (on top of 6e8ae492): `core_dispatch.rs`, `commands/fs.rs`, `services/skills.rs`, `docs/context/web_client.md`. Every regression test below was checked to **fail with its fix reverted** (a mutation run that reverts each fix in turn: vm, symlink, uninstall, wsync, outdir, copylink, relpath — 7/7 failed as expected, then were restored).

### Per finding
1. **import_project `vm` bypass: CONFIRMED, fixed.** `ImportProjectRequest` has no `vm` field. The `LocalSite` kind is split: `LocalSite` (only a non-null `remote` exempts; import) and `LocalSiteOrVm` (create_project, whose body honours `vm.enabled`). Test: `a_users_new_project_folder_is_held_unless_the_site_is_remote` now holds `import_project` + `vm:{enabled:true}`.
2. **`skills_uninstall.name`: CONFIRMED, fixed in the service (all callers).** New `skills::plain_name` accepts a single `Normal` component only: no `/` or `\`, no `.`/`..`, not empty, not absolute, no drive prefix, no NUL, no surrounding spaces. `installed_skill_dir` applies it. Test `uninstall_never_leaves_the_targets_skills_folder` deletes a sibling folder without the fix.
3. **`skills_install`: CONFIRMED, fixed in the service.**
   - The frontmatter name goes through `installed_skill_dir`, so it is refused if it is not a plain name.
   - `relPath` goes through `skill_folder_in`: `/`-separated plain segments, canonicalised, and required to be inside the canonical clone and not equal to it.
   - `sourceId` goes through `cache_dir() -> Result`, which runs `plain_name`.
   - Found siblings, also fixed:
     - `skills_remove_source {id:"../.."}` ran `remove_dir_all` on the state dir's parent. It is now refused before anything is removed.
     - `list_catalog`/`refresh_source` now validate the id.
     - `walk_for_skills` and `list_bundled_files` followed links, which allowed escape and an unbounded loop (stack overflow). They now use `entry.file_type()`.
     - `copy_dir_recursive` copied link targets (for example `notes -> ~/.ssh` into the project). It now skips links.
     - A planted project `.claude/skills -> elsewhere` redirected install and uninstall. The skills dir must now resolve inside the project.
   - Rows `skills_*` `relPath`/`sourceId`, `skills_{refresh,remove}_source.id` and `skills_uninstall.name` are reclassified to `BodyConfined`.
   - Tests: `a_name_joined_onto_a_folder_is_one_plain_component`, `a_catalog_path_stays_inside_its_source`, `a_planted_link_is_never_followed_by_an_install` (unix).
4. **workspace_sync empty `localFile`: CONFIRMED, fixed.** New kind `LocalFileOpt`: empty after trimming passes as `""` (the body takes a `String` and skips it); non-empty must be a known project's file. Test extended in `a_users_local_file_must_be_a_known_projects`.
5. **Symlinked root: CONFIRMED, fixed in `compute_user_roots`.** Chosen rule: a registered root (project, mirror or box) is dropped when
   - any symlink on its spelling (the root itself or an ancestor) sits strictly inside a root, base or registered, by either its spelled or its resolved location (the user can plant such a link after registering), or
   - its canonical form is `$HOME`, app home or the state dir, or an ancestor of one.

   Links above every root (`/home -> /data/home`, macOS `/var`) are still followed. The cost is fail-closed: a folder registered through a link inside a root is no longer one of a user's roots. The rule is documented in the fn doc and in web_client.md. Recording the canonical form at registration would be the alternative, but it needs a schema change. Test: `a_registered_root_swapped_for_a_link_never_widens_the_roots` (unix) covers a leaf swap, an ancestor swap, a link below a registered root, a system link that is kept, and a root that covers home.
6. Speculative, checked one by one:
   - `resolve_text_paths.bases`: CONFIRMED (metadata oracle). New kind `HintEach` drops bases outside the roots. Test: `a_users_link_lookup_bases_outside_their_roots_are_dropped`.
   - `synctex_*.pdf`: CONFIRMED (read oracle). Now `UserPath`. Every frontend caller already catches errors as "no map", so remote viewers degrade silently as before. Test: `a_users_synctex_pdf_is_held`.
   - `set_project_sandbox_spec.spec.dockerfile`: REJECTED as a gap. `sandbox::resolve_spec_dockerfile` refuses absolute paths and `..` and checks the canonical path is inside the project at build time. Row added as `BodyConfined`.
   - `set_project_openvpn.config`: stored only. It is opened only by `openvpn_connect`, which is `Admin` class and takes its `config` as its own argument. Holding it would break legitimately stored configs, which live in the state dir. Not changed; flagged.
   - `check_project_site.req.directory`: comparison only. No change.
   - `set_project_python.interpreter`, `pty_spawn.opts.cwd`, `probe_binaries.bins`: exec paths, and the user has a shell anyway. Inherent; flagged.
   - Nested and struct coverage in the test: NOT done. 106 struct/`Vec` arguments of core commands, about 70 distinct ones, would each need a reviewed row. That is a class-review-sized job, and type-based coverage would still miss `String` leaf names like `name`. Flagged.
7. **Personal skills target: CONFIRMED, fixed for users.** New kind `SkillTarget` on `skills_{install,uninstall,list_installed}.target`: `{kind:"project"}` holds `dir`; any other kind is refused for `Role::User`. Admin and desktop are unchanged. Test: `a_users_skills_go_into_a_held_project_never_the_personal_folder`.
8. **Worktree selection: CONFIRMED (path part), fixed.** New kind `WorktreeOf("projectDir")` on the `worktree` argument of all 21 `git_*` commands that take one. `path` is held unless the project is remote and the site is the host (this mirrors `git::worktree_ctx`: a local project ignores `site`, so `site:"host"` cannot skip the hold). Test: `a_users_selected_worktree_is_held_unless_it_is_on_a_remote_host`. The `.git` gitfile / `core.worktree` redirection is NOT fixed; flagged.
9. **TOCTOU: CONFIRMED in principle, not fixed; flagged.** It needs a symlink creator. #5 removes the shell-free route that widened roots, but a swap between check and use is still possible. The long-term fix is to hand the body the resolved path.
10. **compile_tex `outDir` lexical vs canonical parent: CONFIRMED, fixed.** New helper `source_folder` uses the canonical source's parent, as `compile_tex_blocking` does. Test: `a_relative_output_folder_is_taken_against_the_sources_real_folder` (unix).

### Flagged for user
- **Personal skills target is broken by design on the desktop too.** It writes the real `~/.claude/skills`, which no agent tab sees (tabs run in Tabtivity's agent homes), and it edits another app's config, against the AGENTS.md invariant. Suggest mapping it to the Tabtivity-wide layer (`agent_global`) or removing it.
- `InstalledSkill` reports the frontmatter `name`, while uninstall deletes by folder name. A skill whose folder and frontmatter names differ cannot be uninstalled from the UI. This is pre-existing; a bad name is now refused rather than followed.
- **Repo-controlled git redirection** (`.git` gitfile, `core.worktree` in `.git/config`) can make git run outside a held `projectDir`, on the desktop too for a planted project. Pinning `core.worktree` breaks subfolder `projectDir`s, so it needs its own design.
- TOCTOU between dispatcher check and body (#9); the stored `openvpn.config` (admin acts on it); the nested-coverage test (#6).
- `synctex_status` still stats the source paths listed inside a (now held) map, a 1-bit mtime oracle for paths the map names. Minor; left.

### Gates (commit 30c02942)
- `scripts/gates.sh` (src-tauri selection): brand, whitespace, clippy (`-p tabtivity -p app-serverd --all-targets`), clippy-dlib, clippy-dmn and test (`-p tabtivity -p app-serverd`) all PASS.
- test-dlib: one failure, `markup_rounds::a_round_trip_puts_tracked_new_deleted_and_binary_files_back` (an unrelated module). It passes alone (`--no-default-features --lib -- markup_rounds`: 26 passed) and passed in the default-features `test` gate, so it is load flakiness. Full rerun of `cargo test -p tabtivity --no-default-features --lib --test server_secrets` at 30c02942: 4009 passed, 4 ignored, 0 failed, so PASS.
- Windows msvc `cargo clippy --target x86_64-pc-windows-msvc --all-targets -D warnings`: PASS.
- `cargo check --workspace --all-targets` for x86_64-pc-windows-msvc: PASS. For aarch64-apple-darwin (check-only CC/AR shims): PASS.
- Targeted: `core_dispatch user_roots a_registered_root a_local_file_must skills::`: 42 passed.
- Not run live.

---

## Handoff — M4b sync correctness (screen 2026-10-15 medium plan)

Worktree `.claude/worktrees/med-m4b`, branch `screen-med-m4b`, from develop `2f0569c5`.
Commit: `153c28b8` (one commit on `screen-med-m4b`, on top of `2f0569c5`).

## What changed

### #7 — failed `save_manifest` (all 9 `let _ =` sites)
- New `remote_sync::save_manifest_or_mark_stale(project_id, &mut manifest, recorded: &[String])`
  (+ path-based `save_or_mark_stale_at`, `mark_stale_on_disk`, `forget_base`,
  `UNKNOWN_BASE_SIZE`). On a failed save:
  1. the `recorded` entries' bases are forgotten in the caller's cache copy;
  2. the same marking is written to `sync.json` when it can be — by re-reading the
     file and writing back through `save_manifest_at`'s compare-and-swap (so
     another process's newer version is never clobbered); entries the file does
     not hold stay absent;
  3. the cache stamp is dropped, so the next `ensure_loaded` re-reads the file;
  4. the save's error is returned.
- "Forgotten base" = `host_size`/`local_size = u64::MAX`, both mtimes `None`;
  `selected`, `auto_*`, `excluded` and `last_pull_ts`/`last_push_ts` are KEPT.
  Effect: `divergence` → both sides moved (amber; auto-sync skips), `push_decision`
  → `Stale` (a push asks), status's ≤1 MiB byte-verify heal turns identical
  files green again. Keeping the timestamps means a later pull still WARNS about
  local edits it would overwrite (`unsynced_local_edits`) — a deliberate
  over-warn rather than treating the file as never synced. No schema change
  (u64::MAX sentinel instead of a new field). `base_size` in `sync_file_meta`
  would carry u64::MAX for such a file; the frontend never displays it.
- No new `FileLock` call: the M4c-owned `FileLock::exclusive` lines in
  `save_manifest_at` / `update_manifest` are untouched (text and position).
- Sites:
  - `commands/sync.rs` `sync_status` (heal + prune): background → `eprintln!`;
    recorded = healed rels (prunes: nothing to forget).
  - `sync_apply_delete`: user-initiated → `Err("'<rel>' was deleted, but its sync
    record could not be saved: …")` (recorded = [] — the leftover entry has no
    copy on either side; next status prunes it).
  - `sync_push`: per-file record failure counts as a FAILED file (not `pushed`),
    `first_error = "pushed '<rel>', but its sync record could not be saved: …"` —
    the existing `failed_total`/`first_error` UI shows it.
  - `pull_subtree` (sync_pull / sync_whole_project): keeps pulling, then returns
    `Err("Pulled N file(s), but the sync record of M could not be saved (…); they
    show as changed until they are synced again")`. Note: that Err drops the
    `skippedTooLarge` list for that one run.
  - `services/sync_auto.rs` ×2 (auto pull/push): logged.
  - `services/git_peer.rs`: `forget_synced_paths` (recorded = []),
    `restamp_after_checkout` (recorded = restamped paths), `seed_manifest_after_pairing`
    (recorded = all tracked paths): logged (background).

### SFTP pull keeps the host mode (`replace_local_atomic`)
- `sftp::RawEntry.mode` and `remote_sync::HostFile.mode` (`Option<u32>`, `0o7777`
  mask) from the readdir attrs; new `sftp::metadata_with_mode_on` (metadata_on
  delegates to it). `pull_file`/`pull_file_with` take `host_mode`;
  `write_mirror_file` keeps its signature (no mode) and delegates to new
  `write_mirror_file_with_mode`.
- `replace_local_atomic(local, bytes, host_mode)` stages via
  `tempfile::Builder::permissions(..)`: host mode **through the umask** (choice:
  what rsync gives a new file without `-p`, and a host 0666/0777 file never
  becomes world-writable in the mirror; 0755 stays 0755 under the usual 022);
  no host mode → the existing mirror file's exact mode (fchmod, not followed
  through a symlink); else the umask default (0666 & ~umask). `cfg(unix)` only;
  non-Unix keeps `NamedTempFile::new_in`.
- Side effect: `commands/hpc_ws.rs:915` (`write_mirror_file`, no host mode) now
  writes new files at the umask default instead of 0600.
- `sync_auto` carries the walk's mode (`walked_host_mode`) and stats explicit
  single-file markers with `metadata_with_mode_on`; `pull_subtree`'s single-file
  fallback likewise. Preview's `HostFile`s carry `mode: None` (never written).

### worker_sync — mirror HEAD moved backwards/sideways
- The attempt loop moved into `push_with_fallback(head, last_head, push)`
  (generic over the push, so it is testable). An empty incremental bundle counts
  as "worker has HEAD" only when the excluded commit == HEAD; otherwise it falls
  through to the full bundle (worker is moved by `reset --hard FETCH_HEAD`;
  never `git clean`). An empty FULL bundle is an error (never records a head it
  did not send). Record still written only on success.

### Docs
- `docs/remote_sync_guide.md`: §2.1 failed-record paragraph, §2.5 SFTP mode
  sentence, §4 backwards-HEAD sentence.

## Tests (new)
- `remote_sync::tests::a_failed_manifest_save_after_a_transfer_never_reads_clean`
  (CAS refusal: cache + disk forgotten, other process's entries kept, amber +
  Stale, later save heals to green)
- `remote_sync::tests::an_unwritable_manifest_forgets_the_unsaved_record`
- `remote_sync::tests::an_sftp_pull_keeps_the_host_files_mode` (unix; 0755,
  0644, re-pull mode change, kept local 0750, new file umask default)
- `worker_sync::tests::a_mirror_head_moved_backwards_moves_the_worker_with_a_full_bundle`
  (real git repo, real `build_bundle`)
- `worker_sync::tests::the_bundle_fallback_never_records_a_head_it_did_not_send`

## Gates
`scripts/gates.sh` (touched: src-tauri): brand PASS, whitespace PASS, clippy
(tabtivity + app-serverd, all targets) PASS, clippy-dlib PASS, clippy-dmn PASS,
test PASS (`tabtivity` lib 4090 passed / 4 ignored; 4264 across the run),
test-dlib: first run FAILED 1 — `services::markup_rounds::tests::prune_keeps_the_newest_and_drops_the_old`
(untouched module; `unwrap` on a git snapshot under heavy machine load) — passed on
re-run of that module (26/26) and of the whole gate (3989 passed / 4 ignored +
server_secrets 1). Flaky, not M4b's; worth a look by whoever owns markup_rounds.
Cross-checks (cfg(unix)/cfg(not(unix)) added): Windows clippy (src-tauri, all
targets, -D warnings) PASS; Windows `cargo check --workspace --all-targets` PASS;
macOS `cargo check --workspace --all-targets` (check-only shims) PASS.
Frontend gates not selected (no frontend change). Not run live.

## Flagged for user
- Not run live. Click-through: (1) remote project, host file `chmod 755 run.sh`,
  right-click → Sync to local (with rsync absent on one side, or a single file
  — single files always take SFTP) → `ls -l` in the mirror shows `rwxr-xr-x`.
  (2) Worker: commit twice in the mirror, Sync code now, `git reset --hard HEAD~1`
  in the mirror, Sync code now → worker's `git rev-parse HEAD` equals the mirror's.
  (3) Failed record is hard to provoke live (make `<state_dir>/remote-projects/<id>/`
  read-only, push a file → the tree shows "pushed '<f>', but its sync record
  could not be saved", row amber; restore perms).
- Choice to confirm: host mode is applied through the umask (not verbatim) —
  the plan said "apply the host file's mode (masked to 0o7777)".
- Rows for filemaps: none (no new files). i18n: none (backend English errors,
  like their neighbours).
- `npm run backend:stale` must be run after landing (backend change).
- Merge note for M4c: the two `FileLock::exclusive` lines in `save_manifest_at` /
  `update_manifest` are unchanged in text and place; the new helper adds no lock
  call (it writes through `save_manifest_at`). If M4c's `exclusive_or_unlocked`
  changes `save_manifest_at`, `mark_stale_on_disk` inherits it.
- The commit hook printed "EMBEDDED MOBILE PWA IS STALE" (the running sidecar vs
  `mobile-dist/`) — unrelated to this change.

## Review — M4b

Reviewer pass over `153c28b8` (diff `2f0569c5..screen-med-m4b`).

### Fixed (confirmed, with regression test)
- **SFTP pull applied the host's setuid/setgid/sticky bits.** `replace_local_atomic`
  passed `host_mode & 0o7777` as the `open(2)` create mode, and Linux honours
  `S_ISUID`/`S_ISGID` there (checked live: `open(.., 06755)` → `06755`). An
  unprivileged non-empty write clears setuid/setgid afterwards, but an EMPTY host
  file (no write) — or a privileged process (CAP_FSETID) — kept a planted
  `06755`/sticky bit from an attacker-controlled host. rsync without `-p` drops
  special bits; the SFTP path now does too. Fix: mask `0o777` at the write site
  (host mode AND a kept local mode, since the bytes are the host's) and at the
  source (`sftp::permission_bits`). Test:
  `remote_sync::tests::an_sftp_pull_never_applies_the_hosts_special_mode_bits`
  (failed before: `0o6000` left on the mirror copy). Guide §2.5 sentence updated.
  Commit: `a6d451ea` on `screen-med-m4b`.

### Checked, no bug
- `save_manifest_or_mark_stale`: a forgotten base (`u64::MAX`, mtimes `None`,
  timestamps kept) never yields a pull, push or delete on its own — `divergence`
  flags the local side whenever the mirror exists (size ≠ MAX) or is gone (ts
  kept), so auto-sync gets `(·, true)`: `(true,true)` skips, `(false,true)` asks
  `push_decision`, which is `Stale` (host present ≠ base, or host gone + ever
  synced). Status keeps a one-side-deleted row amber (host fallback `(0,None)`),
  `should_prune` needs both sides positively gone, `sync_apply_delete` is
  user-confirmed and re-verified live. `unsynced_local_edits` over-warns (safe).
  No arithmetic on base sizes anywhere (`base_size` in `sync_file_meta` only).
- CAS: `mark_stale_on_disk` stamps the version it read (stamp taken before the
  read, outside the lock) — any interleaved write makes `save_manifest_at` refuse
  (fails closed, the mark is then lost). A lost mark leaves the disk's OLD base:
  traced both pull and push — the moved side still reads moved (amber/Stale); the
  only non-amber case is a re-pull of an unchanged green file, where auto-sync
  may push back the identical bytes. No forced/blind push past a lost mark.
  Cache stamp dropped on every failure path → next `ensure_loaded` re-reads.
- Lockstep split: `forget_synced_paths` / `restamp_after_checkout` /
  `seed_manifest_after_pairing` only touch tracked paths' records; `drop_tracked`
  still removes them from auto-sync candidates; no new byte movement.
- worker_sync: backwards/sideways HEAD falls through to the full bundle
  (`reset --hard FETCH_HEAD`, never `git clean`, tracked only); the record is
  written only on `Ok`; an empty full bundle is an error. Tests sound.
- `hpc_ws` logs now land at the umask default instead of 0600 — same as rsync;
  not a secret-bearing path.

### Flagged for user (not changed)
- Worker-local commits / tracked edits on a synced-copy worker are dropped by
  `reset --hard` on every sync (now also when the mirror moves backwards). By
  design (push-only), and `local_loss` records desktop-local losses only — but
  nothing tells the user a worker had commits of its own. Pre-existing.
- `force` ("Sync code now") with `last_head == HEAD` still answers "skipped" from
  the empty incremental bundle without re-applying, so a worker whose tree
  drifted (someone reset it there) is not put back. Pre-existing; a forced sync
  could start with the full bundle.
- A host file with mode `0o000`/`0o200` now lands unreadable to the owner in the
  mirror (rsync does the same); status byte-verify / push then fail on it
  (no data loss). Could OR in `0o600` if wanted.
- Agree with the implementer's choice to apply the host mode through the umask
  (not verbatim) — it is what rsync gives and avoids world-writable copies.

### Gates
`scripts/gates.sh` (touched: src-tauri) after the fix: brand, whitespace,
clippy (tabtivity + app-serverd, all targets), clippy-dlib, clippy-dmn, test,
test-dlib — all PASS (no markup_rounds flake this run). Frontend gates skipped
(no frontend change). Windows/macOS cross-checks not rerun: the fix changes a
mask constant inside existing `cfg(unix)` code and an un-gated constant in
`sftp.rs` — no new cfg, path or spawn code (implementer's runs on `153c28b8`
stand). Not run live; `npm run backend:stale` still owed after landing.

---

## Handoff M4c — process/locks (FileLock #8, graceful reap #9, mail verifier)

Branch `screen-med-m4c` (worktree `.claude/worktrees/med-m4c`), from develop `2f0569c5`.
Commit: `6979a448` (one commit, 12 files under src-tauri/src).

## What changed

### #8 `FileLock` (src-tauri/src/storage.rs)
- `FileLock::exclusive` now propagates a failed `flock`/`LockFileEx` like
  `shared()` always did (it used to `let _ = file.lock()`).
- New explicit lockless fallback: `FileLock::exclusive_or_unlocked` /
  `shared_or_unlocked` → `io::Result<Option<FileLock>>`; `Ok(None)` only when
  `storage::lock_unsupported(&e)` (unix: `ENOLCK`, `EOPNOTSUPP`, `ENOTSUP`,
  `ENOSYS`; Windows: `ERROR_INVALID_FUNCTION` 1, `ERROR_NOT_SUPPORTED` 50;
  any OS: `ErrorKind::Unsupported`). Logged once per directory
  (`eprintln!`). Every other error propagates.
- Struct doc rewritten (the "best effort" paragraph is gone).

Call-site triage (all `FileLock` users):

| Site | Revision/CAS check? | Now |
|---|---|---|
| `storage::patch_json` | named by the plan | `exclusive_or_unlocked` |
| `remote_sync::save_manifest_at` | stamp CAS (`CHANGED_ELSEWHERE`) | `exclusive_or_unlocked` (one of the two FileLock lines; M4b owns the rest) |
| `remote_sync::update_manifest` | no (plain RMW) | `exclusive`, unchanged text — now propagates |
| `commands/boxes.rs` `save_boxes_at` | per-box rev CAS | `exclusive_or_unlocked` |
| `commands/boxes.rs` `write_boxes`, `patch_box_at` | no (stamps revs, never compares) | `exclusive` (propagates) |
| `commands/calendar.rs` `write_data_cas` | `rev` CAS | `exclusive_or_unlocked` |
| `services/agent_tasks.rs` `lock()`/`file_lock()` (13 uses) | no — the claim is the at-most-once check and only holds under the lock | was `.ok()` (swallowed every error); now `Result`, `lock()?` |
| `services/agent_prompts.rs` `lock()` + 4 `*_at` | no revision | was `.ok()`; now `Result`, propagates |
| `services/agent_auth.rs` `reconcile_home_step` | no | was ignored; now a failed lock skips that pass with a log (keeper retries next poll / next spawn) — fn returns `()` |
| `services/process_lease.rs` `hold_at` (`shared`) | lease | `shared_or_unlocked` (unguarded on lockless FS, as the module documents) |
| `services/process_lease.rs` `free_to_tear_down_at` | lease | `try_exclusive` error: lockless → teardown proceeds unguarded (`TearDown { _lock: None }`, new type); any other error → `None` (stays). Was: any error → `exclusive().ok()`, which silently returned an unlocked guard |
| `workspace::{snapshot_in,sync_in,edit_in}`, `calendar_alarms::claim_in`, `timer_lease::{acquire_in,release_in}`, `terminal_service::rewrite_session_paths`, `agent_home` prepare, `brand_migration/persisted::rewrite_json_locked` | no CAS at write (versions merge, claims, leases) | already `?` — now actually propagate lock failures; no code change |

### #9 graceful reap (src-tauri/src/terminal/mod.rs, sysstat.rs)
- New `Doomed { pid, start: Option<u64> }`; `doomed_subtree(leaders)` walks afresh and
  records identity. Linux: pids and start times from the **same**
  `proc_table::snapshot_within(ZERO)` walk. macOS/Windows: `sysstat::descendant_pids` +
  new `sysstat::process_start(pid)` (macOS `proc_bsdinfo.pbi_start_tv{sec,usec}` in µs;
  Windows `GetProcessTimes` creation FILETIME; Linux `/proc/<pid>/stat` field 22;
  fallback backend `None`).
- Unix `reap_pids` → `reap_with(doomed, mode, start_now, send)`: every signal (SIGTERM
  and SIGKILL, all three modes incl. `Immediate`) only to a pid whose current start
  time equals the recorded one; `None` is never signalled. `GracefulBlocking`'s
  "still alive" poll uses the same identity check. `Graceful`'s detached SIGKILL
  re-checks after its 2 s sleep.
- Windows: `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)`,
  `GetProcessTimes` on that same handle, `TerminateProcess` only on a match (the open
  handle pins the process, so check and kill see one process).
- `kill`/`kill_all`/`teardown_taken`/`reap_child_subtree` all go through
  `doomed_subtree`; the existing `kill_reaps_the_child_subtree` and
  `taken_ptys_leave_the_registry_and_one_teardown_reaps_every_subtree` still pass
  (whole subtree reaped).

### mail_engine verifier
- `tls_config()` → `Result<Arc<ClientConfig>, String>`; the `OnceLock` stores the
  `Result` (`cached_tls_config`), so a broken platform verifier is answered to every
  connect as `MailError::Protocol(...)` (mail) / `Err` (`services/connect.rs`) instead
  of panicking. No `.expect` left.

## Tests added
- storage: `a_failed_lock_is_an_error_and_only_a_lockless_file_system_falls_back`,
  `lock_unsupported_names_only_the_lockless_errors` (injected lock fn via
  `FileLock::take`).
- terminal (unix test module): `a_doomed_process_is_itself_only_with_the_same_start_time`,
  `graceful_reaps_never_signal_a_recycled_pid` (GracefulBlocking + Graceful, a pid
  recycled after the SIGTERM gets no SIGKILL), `an_immediate_reap_signals_only_the_walks_processes`,
  `a_real_process_with_a_changed_start_time_survives_the_reap` (real `sleep` child,
  start+1 → survives; own start → reaped).
- mail_engine: `a_broken_platform_verifier_is_an_error_not_a_panic`.

## Gates (worktree, own target dir)
- `scripts/gates.sh` (selected: brand, whitespace, clippy tabtivity+app-serverd
  --all-targets, clippy --no-default-features --lib, clippy app-serverd, cargo test
  -p tabtivity -p app-serverd, cargo test --no-default-features --lib --test
  server_secrets): **all PASS** (logs removed on success, so no per-binary counts; a
  targeted run of the touched modules gave 471 passed, the 9 new/affected
  reap/lock/verifier tests all pass). Frontend gates not selected (no frontend change).
- Linux clippy re-run after the last cosmetic edit (`Doomed` made module-private): clean.
- Cross-checks: Windows msvc `cargo clippy --manifest-path src-tauri/Cargo.toml
  --target x86_64-pc-windows-msvc --all-targets -- -D warnings` clean;
  `cargo check --workspace --all-targets` for x86_64-pc-windows-msvc and
  aarch64-apple-darwin (check-only CC/AR shims) clean. The Windows reap path and
  macOS `process_start` are type-checked only, never run.
- Daemon crate not touched (only the library it builds); no `ldd` check needed.
- `npm run backend:stale` not run from the worktree (main agent runs it after landing).

## Filemap rows (for the main agent; filemaps not edited here)
- `docs/filemap_backend.md` `storage.rs` row: append "`FileLock::exclusive`/`shared`
  fail on any lock error; `*_or_unlocked` is the explicit lockless fallback
  (`lock_unsupported`), only for callers with a revision/CAS check."
- `sysstat.rs` row (if any): "`process_start(pid)`: the platform's process start time
  (pid identity across reuse)."

## Gotchas
- `process_lease::free_to_tear_down` now returns `Option<TearDown>` (was
  `Option<FileLock>`); the callers in `sandbox.rs`/`vm.rs` only hold it, so they
  compile unchanged.
- `remote_sync.rs`: only the `save_manifest_at` FileLock line (+ a one-line comment)
  changed; `update_manifest`'s line is textually unchanged. Merge after M4b should be
  trivial.
- The Graceful identity test sleeps 2.5 s (the detached escalation's grace).

## Flagged for user
- On a state dir with **no advisory locks** (NFS without lockd, odd FUSE/SMB),
  the stores without a revision check now fail loudly instead of racing silently:
  tab sync (`workspace`), agent prompts/schedules, calendar alarm claims, the timer
  lease, box edits other than the whole-list save, agent-home preparation (agent
  spawn), and the login keeper (skips its pass). That is decision #8 as written;
  Linux flock on a `nolock` NFS mount or a FUSE fs without its own lock op succeeds
  locally, so this should be rare. If you want any of these to keep working
  unguarded, it is a one-word switch to `exclusive_or_unlocked` at that site.
- `process_lease` keeps an explicit lockless fallback although it has no revision
  check (leases are documented as "unguarded, as before leases existed" there):
  otherwise a lockless state dir would never tear down a container/VM. `claim_at`
  (try_exclusive error → run anyway) is unchanged.
- Not run live.

---

## Handoff M4d — client ssh login provenance (fixed decision #12)

Branch `screen-med-m4d` (worktree `.claude/worktrees/med-m4d`), from M4a's `6e8ae492`.
Commits: `f664c6e9` (code, docs, tests, local class row + regenerated `commandClasses.ts`, `untested.ts` row) and `a122c810` "chore(i18n): M4d keys (main agent re-applies)" (author noreply; hooks ran).

## What changed

- `src-core/src/ctx.rs` (+ `lib.rs` export) — `Role { User, Admin }` moved here
  from `core_dispatch` (same `as_str`/`parse`); `CoreCtx` gains a private
  `client_role: Option<Role>`, set only by the new `CoreCtx::with_client(client,
  role)`. `with_caller`/`new` leave it `None`. `client_role()` (a `Client` with no
  role reads as `User` — fails closed) and `is_untrusted_client()` (= `Client` and
  not admin; `System`/`Local` trusted). Test `only_a_users_client_is_untrusted`.
- `services/core_dispatch.rs` — `pub use app_core::Role;` replaces the enum (all
  `core_dispatch::Role` users unchanged). `dispatch(ctx, role, …)` keeps its role
  parameter and order (class → feature → model allowlist → confine_for_user → wrapper).
- `services/mobile_control/web_client.rs` — `serve_socket` builds the call ctx with
  `state.ctx.with_client(client, role)` (the session's role, fixed at login, never a
  frame). Module doc "Who the caller is" says so. `Caller` import dropped.
- `schema/project.rs` — `RemoteSpec.added_by_client: Option<bool>`
  (`serde(default, skip_serializing_if = none)`) + `RemoteSpec::awaits_approval()`.
  `ComputeHost` flattens `RemoteSpec`, so primaries and workers both carry it; old
  entries without it are the desktop's and round-trip byte-identical.
- `services/remote.rs` — `ssh_addresses_of`/`configured_project_ssh_addresses` now
  return `(SshAddress, counts: bool)` (stamped = false); new `same_ssh_address` and
  `carry_provenance(spec, stored, untrusted)`: the incoming value is always
  overwritten; an unchanged address (compared as `ssh_account` spells it) keeps the
  stored provenance; a new/changed one is stamped iff untrusted.
- `commands/credentials.rs` — `ssh_login_known` returns `LoginHost::{Known(stored
  address), Unapproved, Unknown}` (a counting match wins); `ssh_login_configured`
  skips nothing but marks stamped project hosts non-counting (global machines always
  count — only admin commands write them). `apply_login_with` (client callers only):
  `Known` → the target is **replaced by the stored spelling** before the argv is
  built; `Unapproved` → error starting with `SSH_LOGIN_UNAPPROVED`
  (`app_env!("SSH_LOGIN_UNAPPROVED")`); `Unknown` → the old message. Desktop logins
  never consult the list and are never rewritten. Module comment updated.
- Writers stamped (every write of a `RemoteSpec`/`ComputeHost` address reachable by
  a client; grep of `insert("remote"`, `"compute_hosts"`, `.remote =`,
  `patch_remote_spec`, `patch_compute_hosts`):
  - `create_project` (now takes `Ctx`) → `create_project_as(req, untrusted)`; stamp
    applied after the VM spec is synthesized, so a user's VM project is stamped too.
    `create_project_blocking(req)` = trusted (phone / tests).
  - `import_project` (now takes `Ctx`) stamps `req.remote` before the blocking body;
    `share_add` imports local only.
  - `extend_project_to_remote` (had `Ctx`) stamps `req.remote`.
  - `set_project_remote_user` (now takes `Ctx`): user change → `carry_provenance`.
  - `add_compute_host` (now takes `Ctx`): new id → caller decides; re-add of an
    existing id → carry against the stored spec.
  - `patch_compute_host` (now takes `Ctx`; `#[allow(clippy::too_many_arguments)]`):
    user change → carry.
  - `import_project_export` (now takes `Ctx`) → `import_project_export_as(req,
    untrusted)`; `stamp_imported_hosts` drops the bundle's value on `remote` and each
    `compute_hosts` entry and stamps for an untrusted importer (entry + project.json).
    `import_project_export_blocking` = trusted.
  - Not writers of an address (checked): `save_projects` (copies status/position/
    box_id only — cannot clear a stamp; tested), `set_project_openvpn`,
    `set_project_auto_connect`/`persist_sessions`/`remote_label`,
    `record_*_key_auth`, `hpc_ws_move_root` (re-reads the stored spec, changes
    `remote_path`), `vm::record_vm_endpoint` (system; patches the stored spec, keeps
    the stamp), `restore_archived_project` (entry from the state-dir archive, stamp
    kept), `rename_project_dir` (path-prefix rewrite), `detach_project_from_remote`
    (removes), global machines (all admin-class).
  - Frontend payloads are unchanged: `Ctx` is never in the payload.
- New command `approve_client_ssh_host { projectId, hostId }` (`commands/projects.rs`,
  `cfg_attr(feature = "desktop", tauri::command)`, takes `Ctx`): `primary` → clears
  the primary's stamp; else the worker's (unknown worker → error). Refuses an
  untrusted client in the body too. Registered in `lib.rs`.
- Frontend: `types/index.ts` `RemoteSpec.added_by_client?`; `lib/remote/loginTarget.ts`
  `SSH_LOGIN_UNAPPROVED` + `loginHostUnapproved(e)`; `TerminalView.tsx` prints the
  i18n'd `terminal.loginHostUnapproved` (yellow) instead of the raw spawn error;
  `RemoteMachinesWindow.tsx` — file-local `ClientHostApproval` under the primary card
  and each worker card when `added_by_client === true`: an "Added from a browser" tag,
  the UntestedTag, and **Allow browser logins** → `approve_client_ssh_host`, then the
  store's project entry is patched (stamp dropped).
- Docs: `docs/context/remote_credentials.md` (allow-list paragraph),
  `docs/context/web_client.md` ("One user, role admin" bullet).

## Hot-file rows (main agent re-applies at the tip)

- `services::command_class` (M5 owns): `("approve_client_ssh_host", Admin),` in the
  `// commands/projects.rs` block, after `adopt_folder_tab_layout`. Applied locally;
  `commandClasses.ts` regenerated locally (one row `["approve_client_ssh_host",
  "admin"]`). Regenerate once at the tip.
- `src/lib/i18n.ts` + dicts (M1 owns) — separate commit "chore(i18n): M4d keys (main
  agent re-applies)". Script that inserts them idempotently (run from repo root):
  `<scratchpad>`.
  Keys (en / de / es / fr / it in the script):
  - `terminal.loginHostUnapproved` — "A browser account added this host, so a browser
    gets no login terminal to it until the desktop or an admin allows it (Remote
    machines → Allow browser logins)."
  - `remoteMachines.clientAddedTag` — "Added from a browser"
  - `remoteMachines.clientAddedTitle` — "A browser account that is not an admin added
    this address. Browser clients get no ssh login terminal to it until you allow it."
  - `remoteMachines.allowClientLogins` — "Allow browser logins"
  - `remoteMachines.allowClientLoginsFailed` — "Could not allow logins: {error}"
- `src/lib/untested.ts` (applied locally): `"remoteMachines.allowClientLogins": { area:
  "projects", what: "RemoteMachinesWindow · 'Added from a browser' tag + Allow browser
  logins: …(screen 2026-10-15 #12)" }` after `remoteMachinesWindow.4`.
- Filemaps (not edited): `docs/filemap_backend.md` `credentials.rs` row — add "a
  client's ssh login counts only hosts the desktop/an admin stored
  (`RemoteSpec.added_by_client`) and runs to the stored spelling"; `services/remote.rs`
  row — "`carry_provenance` (who stored a host address)"; src-core `ctx.rs` row —
  "`Role`, `CoreCtx::with_client`/`is_untrusted_client`". Frontend map
  `RemoteMachinesWindow.tsx` — "Allow browser logins for a host a browser account
  stored".

## Tests

- src-core: `only_a_users_client_is_untrusted`.
- credentials: `a_host_a_user_client_stored_gets_no_login_until_approved` (stamped →
  Unapproved + marker, admin client held too; legacy/`false` → Known; same address
  approved elsewhere counts), `a_clients_login_runs_to_the_stored_spelling`
  (`Host.Example ` port 22 → argv `alice@host.example`, no `-p`; desktop untouched);
  existing allow-list tests adapted to `LoginHost`.
- remote: `provenance_is_the_callers_and_follows_the_address`.
- schema: `host_provenance_is_optional_and_round_trips`.
- project_transfer: `imported_hosts_take_the_importers_provenance`.
- integration (`tests/projects_commands.rs`):
  `a_host_a_user_client_stores_gets_no_login_until_approved` — drives
  `create_project` (user/admin/desktop; client-sent provenance ignored),
  `pty_spawn` login as a user client (stamped → marker; unknown → old refusal),
  `save_projects` cannot clear, user approve refused, desktop/admin approve clears,
  `add_compute_host` (user/desktop/user re-add unchanged), `patch_compute_host` user
  change by a user → stamped, unknown worker approve errors, `import_project` and
  `extend_project_to_remote` as a user → stamped, login to the extended host refused.
- vitest: `src/__tests__/remote/LoginHostUnapproved.test.ts`.

## Gates

`scripts/gates.sh` (selection: frontend, src-core, src-tauri) on the working tree with
both commits' content: PASS brand, whitespace, lint-fe, clippy (`-p app-core -p tabtivity
-p app-serverd --all-targets -D warnings`), clippy-dlib, clippy-dmn, build. vitest
`--changed`: 5761/5762 — the one failure was `src/__tests__/mobile/MobileIndicator.test.tsx`
("iPad" not found after waitFor; file untouched by M4d, a load flake): rerun alone with
`LoginHostUnapproved`, `UntestedRegistry`, `i18n` tests → 4 files / 26 tests pass.
Because the gate script stops at the first failure, the cargo gates were run by hand:
`cargo test -p app-core -p tabtivity -p app-serverd` → 4380 passed, 0 failed (lib suite
4003 + 4 ignored); `cargo test -p tabtivity --no-default-features --lib --test
server_secrets` → ok. `cargo build -p app-serverd` + `ldd tabtivity-serverd`: no
GTK/WebKit/X11/dbus.

## Cross-checks

Windows msvc `cargo clippy --manifest-path src-tauri/Cargo.toml --target
x86_64-pc-windows-msvc --all-targets -- -D warnings` (eldrun-msvc rc/lib shims) PASS;
`cargo check --workspace --all-targets` for `x86_64-pc-windows-msvc` PASS and
`aarch64-apple-darwin` (check-only cc/ar stand-ins, as `ci-local.sh`) PASS. The
integration test uses `.invalid` hosts and tempdirs (no path literals); the credentials
unit tests compare argv strings only.

`npm run backend:stale` not run: this worktree is not the running window's tree; after
landing, run it on the tip (backend changed: new command, ctx role, allow-list).
Post-commit hook printed "MOBILE BUNDLE IS STALE" — pre-existing, M4d touches no
`mobile-web/`.

## Click-through (not run live)

1. Desktop: open a remote project's Remote machines window — no new tag on existing
   hosts (legacy = desktop's).
2. Browser client signed in as a **user** account (gateway role user): create a remote
   project (or add a machine) → open its login terminal → the pane says the host
   needs the desktop/an admin to allow logins (yellow), nothing dials.
3. Desktop: Remote machines for that project → "Added from a browser" tag + **Allow
   browser logins** → tag goes; the browser's login now opens.
4. Browser user: change the login name of that host (Connect dialog) → tag back.
5. Browser **admin** session: a host it adds has no tag; its Allow button works on a
   user's host.

## Flagged for user

- Admin browser clients are held to the same allow-list (stamped hosts refused until
  approved) — the decision says only that the list counts desktop/admin-added hosts.
- A trusted (desktop/admin) edit that changes a stamped host's address (e.g. the login
  name) unstamps it — the new address is the desktop's own choice. A trusted edit that
  keeps the address (label, toggles, re-add) never approves.
- Not covered (per plan): non-login `core` ssh commands still dial a host a user names.
- Not run live.

## Rework — M4d (decision change)

Branch `screen-med-m4d`: `1ac61a1e` merges `screen-med-m4a` (picks up `30c02942`,
clean, no conflicts), then `a41799cc` "fix(security): a per-user daemon's account owns
its ssh hosts; client logins run to the stored spelling" (noreply author, hooks ran).
Net diff vs `screen-med-m4a` is now 4 files: `commands/credentials.rs`,
`schema/project.rs` (test only), `docs/context/remote_credentials.md`, and a stray
trailing blank line dropped from `RemoteMachinesWindow.tsx` (the base had it; `git
diff --check` flagged it once M4d's edit was undone).

**Removed** (files back to M4a's content): `RemoteSpec.added_by_client` +
`awaits_approval`; `services::remote::carry_provenance`/`same_ssh_address` and the
`(SshAddress, bool)` shape of `ssh_addresses_of`/`configured_project_ssh_addresses`;
every stamping call — `create_project`, `import_project`, `set_project_remote_user`,
`add_compute_host`, `patch_compute_host`, `import_project_export` are back to their
pre-M4d signatures (no `Ctx`, no `_as` variants), `extend_project_to_remote` and
`project_transfer`'s `stamp_imported_hosts` gone; `approve_client_ssh_host` (command,
`lib.rs` registration, `command_class` row, `commandClasses.ts` row); the
`LoginHost::Unapproved` path + `SSH_LOGIN_UNAPPROVED`; the `RemoteMachinesWindow`
tag/button/UntestedTag and its `untested.ts` row; `TerminalView`'s translated refusal
+ `loginTarget.ts`'s `loginHostUnapproved` + its vitest file; the five i18n keys
(a122c810's content); `types/index.ts` field; the gate text in `remote_credentials.md`
and `web_client.md`; the integration test. **Role plumbing removed**: nothing used
`CoreCtx::with_client`/`is_untrusted_client` after the rework, so `Role` is back in
`core_dispatch`, `CoreCtx` has no `client_role`, and `web_client.rs` builds the call
ctx with `with_caller(Caller::Client(..))` again.

**Kept**: client ssh login only to a stored host (typo guard); `ssh_login_known` now
returns `Option<SshAddress>` — the matched entry's stored spelling — and
`apply_login_with` rebuilds the target from it before the argv. Tests:
`a_clients_login_runs_to_the_stored_spelling` (plus a KELVIN SIGN case: caller
`"\u{212A}DC.example"` against stored `kdc.example` → argv `alice@kdc.example`, all
ASCII), new `a_host_an_earlier_build_marked_client_added_counts` (both
`added_by_client` and `addedByClient` entries still count), new schema test
`a_host_marked_added_by_client_loads_and_round_trips` (project.json and a
projects.json entry load; the key rides in `RemoteSpec.extra` and is written back).
Doc paragraph in `remote_credentials.md` says the account owns its hosts and the list
is a typo guard, and keeps the "not covered: non-login ssh commands" note.

**Gates** (`scripts/gates.sh`, selection frontend + src-core + src-tauri vs the merge
commit): all PASS — brand, whitespace, lint-fe, clippy (`-p app-core -p tabtivity -p
app-serverd --all-targets -D warnings`), clippy-dlib, clippy-dmn, build, vitest
`--changed` (621 files / 5759 tests), cargo test `-p app-core -p tabtivity -p
app-serverd` (4212 passed, 4 ignored), test-dlib. `cargo build -p app-serverd` + `ldd
tabtivity-serverd`: no GTK/WebKit/X11/dbus.

**Cross-checks**: Windows msvc `cargo clippy --manifest-path src-tauri/Cargo.toml
--target x86_64-pc-windows-msvc --all-targets -- -D warnings` PASS; `cargo check
--workspace --all-targets` for `x86_64-pc-windows-msvc` PASS and
`aarch64-apple-darwin` (check-only cc/ar stand-ins) PASS.

`npm run backend:stale` not run (worktree is not the running window's tree); run it
on the tip after landing. Post-commit printed "EMBEDDED MOBILE PWA IS STALE" —
pre-existing, nothing in `mobile-web/` changed.

**Hot-file rows now**: no `command_class` row, no `commandClasses.ts` row, no i18n
keys, no `untested.ts` row to re-apply — drop the earlier M4d rows from the tip plan.
Filemap (optional): `docs/filemap_backend.md` `credentials.rs` row — "a client's ssh
login runs to the stored spelling of the matched host".

**Flagged for user**
- On a per-user daemon a user can store any host and then open a login tab to it —
  by the decision; the stored-host check is only a typo guard there.
- `added_by_client` keys an M4d build may have written stay in `projects.json`
  (carried in `extra`, inert); nothing strips them.
- Non-login `core` ssh commands still dial any host a user names (unchanged).
- Not run live.

---

## M4d security review — finder (screen-med-m4d, 6e8ae492..a122c810)

Read-only review. Scope: `RemoteSpec.added_by_client` provenance, `CoreCtx` role,
writer stamping, `approve_client_ssh_host`, stored-spelling argv.

## Writer inventory (checked)

projects.json `remote` / `compute_hosts` writers found by grep (`insert("remote"`,
`insert("compute_hosts"`, whole-entry `list.push`, `patch_remote_spec`,
`patch_compute_hosts`):

| Writer | Client-reachable | Stamps? |
|---|---|---|
| `create_project` (+ VM branch) | core | yes (`carry_provenance(None)`) |
| `import_project` | core | yes (async wrapper) |
| `extend_project_to_remote` | core | yes; refuses an already-remote project |
| `add_compute_host` (new / replace-by-id) | core | yes (see F2 for the replace path) |
| `patch_compute_host` (`user`) | core | yes |
| `set_project_remote_user` | core | yes |
| `import_project_export` (bundle) | core | yes (`stamp_imported_hosts`, entry + project.json) |
| `save_projects` | core | n/a: writes status/position/box_id only |
| `restore_archived_project` | core | keeps the archived entry verbatim (stamp preserved); `archive/` is outside `fs::user_roots` |
| `hpc_ws_move_root` | core | keeps spec, changes `remote_path` only |
| `services::vm::record_vm_endpoint` | system (vm_* are admin) | keeps stamp |
| `create_project_for_phone`, `share` join | system | local projects only (`remote: None`) |
| `global_machine_*` | all admin | n/a |
| MCP lanes (root/git_push/schedule/…) | — | none write hosts |

No client-reachable writer that skips stamping was found. `with_caller(Client)` is
never used in production code (only `with_client`), a role-less client context
fails closed to User, `Local`/`System` are trusted, and the only `Role::User`
sessions are gateway device sessions (`authenticate`): the sidecar's token login
is always Admin.

## Likely real

### F1 — Medium (design/functional): on a gateway server nobody can ever approve a user's host, and the gate buys no security there
- Where: `src-tauri/src/commands/projects.rs:2502` (`approve_client_ssh_host`),
  `src-tauri/src/services/command_class.rs:757` (Admin), `src-tauri/src/commands/credentials.rs:266-282`.
- Scenario: `Role::User` exists only behind the gateway, and each account has its
  own daemon (`<slug>-serverd@<user>`, docs/server.md table; docs/context/server_gateway.md
  "The role is the gateway's alone"). That daemon has no desktop window (`Caller::Local`
  never occurs) and the admin's browser is routed to the admin's own daemon, never to the
  user's. So every host a user stores is stamped and `approve_client_ssh_host` is
  unreachable for it: login terminals ("Sign in in a terminal") are permanently dead for
  every non-admin server account, apart from promoting the account to admin. In the
  single-user sidecar every client is Admin, so nothing is ever stamped. The stamp
  therefore only ever exists where nobody can clear it.
- Security value there: none. The user's daemon runs as the user and serves unfenced
  shell tabs (`core_dispatch.rs:169-172`: "`pty_spawn` is `core`"). The user can
  `ssh` to any host from a plain tab, edit `projects.json` (their own state dir) to drop
  the stamp, or alias any approved host in `~/.ssh/config`. The secrets the login pastes
  are the user's own keychain entries. `ssh_connect`/`ssh_probe` still dial any host
  (accepted in the plan).
- Suggested fix (needs the user's call, since #12 is their decision): either (a) treat a
  per-user daemon's own account as the owner of the hosts it stores (stamp only when
  clients of different trust share one daemon, which never happens today), or (b) add a
  real approval path for servers (an admin-helper verb or a gateway admin page that
  writes the user's `projects.json`). At minimum, (c) hide the "Allow browser logins"
  button for non-admins (`server_capabilities.role`, as `ServerSettings.tsx:52` does) and
  reword `terminal.loginHostUnapproved` / the backend refusal. Both point a server user
  to "the desktop or an admin … Remote machines", which they cannot reach.

### F2 — Low: a user can rewrite the stored spelling of a desktop/approved worker and keep it unstamped, which weakens "argv uses the stored spelling"
- Where: `src-tauri/src/services/remote.rs:239-244` (`carry_provenance`, the
  unchanged-address arm) via `src-tauri/src/commands/projects.rs:2484-2492`
  (`add_compute_host` replace-by-id stores the **incoming** spec).
- Scenario: the desktop stored worker `w1` = `alice@kdc.example`. A user client calls
  `add_compute_host(p, {id:"w1", user:"alice", host:"\u{212A}dc.example"})`.
  `ssh_account` uses Unicode `to_lowercase` + trim, and KELVIN SIGN U+212A lowercases
  to ASCII `k`, so the address counts as "unchanged". The provenance stays desktop and
  the stored host becomes the user's spelling. A later client login matches it, and
  the argv is built from the now user-chosen string. The test in
  `tests/projects_commands.rs` encodes this behaviour: it re-adds `"WD.invalid "` and
  asserts the entry stays unstamped. Practical reach is small: glibc won't resolve
  non-ASCII names, and trailing whitespace or case is harmless to ssh. The redirect
  would need `/etc/hosts` or an `ssh_config` `Host` line, which a user with a shell
  could write anyway (F1). The invariant the plan asked for ("ssh receives the stored
  spelling of the owner's entry") does not hold, though.
- Fix: in the unchanged-address arm, copy the stored `user`/`host`/`port` back over
  the incoming ones (`spec.user = old.user.clone(); spec.host = old.host.clone(); spec.port = old.port;`).
  Alternatively, treat any raw-spelling difference as a changed address (stamp for an
  untrusted caller). Optionally refuse non-ASCII hosts in the allow-list match.

### F3 — Low: a worker id `"primary"` collides with the approval key
- Where: `src-tauri/src/commands/projects.rs:2482` (`add_compute_host` mints an id only
  when it is empty) and `:2511` (`approve_client_ssh_host` treats `"primary"` as the primary).
- Scenario: a client adds a worker with `id: "primary"` (stamped). The UI's
  `ClientHostApproval hostId={w.id}` sends `"primary"`, which clears the **primary's**
  stamp. The worker stays stamped forever, and an admin who meant to approve the worker
  approved the primary instead. This is not an escalation, since the primary is an
  owner-visible address too, but the approval lands on a different address than the one
  shown.
- Fix: refuse or re-mint `host.id == PRIMARY_HOST` in `add_compute_host`. Better still,
  bind approval to the address (F4).

## Speculative

### F4 — Low: approval is keyed by id, not by the address the approver saw (TOCTOU)
- Where: `src-tauri/src/commands/projects.rs:2502-2523`.
- Scenario: the admin sees worker `w1` = host B and clicks Allow. In between, the user
  replaced `w1` with host C via `add_compute_host`, which is stamped again. The approval
  clears C. This only matters once a daemon serves both an approver and a user (not
  today, see F1).
- Fix: take the expected `(user, host, port)` in `approve_client_ssh_host` and refuse
  when the stored entry no longer matches under `same_ssh_address` and exact spelling.

### F5 — Info: hosts stored before the field existed, or by an older build, count as the desktop's
- `schema/project.rs:148-158`. By design (decision #12), but note: if a server is
  downgraded and upgraded again, any host a user stored meanwhile reads as approved.
  Older builds keep the field through `RemoteSpec.extra` (flatten), so a round trip
  does not drop a stamp.

### F6 — Info: the desktop's Remote machines window does not refresh when a stamp appears
- `RemoteMachinesWindow.tsx:708,819` reads `added_by_client` from the projects store.
  A stamp written by a client after the window loaded shows only after a reload. This
  is moot today, since a desktop never coexists with a User client (F1).

## Checked, no finding
- The role cannot be forged from a frame. The session role is fixed at upgrade
  (`web_client.rs:1142`); `Role::parse` fails closed; `client_role()` defaults a
  role-less client to User; re-deriving with `with_caller` drops the role. Tested in
  `ctx.rs`.
- `approve_client_ssh_host` is Admin-class, and its body refuses `is_untrusted_client`.
  No other command clears the field: `save_projects` ignores it, and every writer
  ignores the incoming value.
- `is_untrusted_client` is used only in host writers and approval. Desktop
  (`Local`) and System paths are always trusted.
- Allow-list fail-closed: an unparseable `remote` or `compute_hosts` drops the host,
  and a malformed stamp fails the spec parse. IPv6 brackets and trailing dots compare
  unequal, so the match is conservative. User names are not case-folded.
- The argv is built from the matched stored entry. The desktop's own logins are never
  rewritten.
- The bundle import strips or stamps both `entry_value` and `project_value`, primary
  and workers. A trusted import drops the bundle's own stamp, by design: the importer
  stored the hosts.

---

## Handoff M5 — dead IPC + unused deps

Branch `screen-med-m5` (worktree `.claude/worktrees/med-m5`), from develop `2f0569c5`.
Commit: `59917cac` chore(ipc): delete 19 uncalled commands, unused src-tauri deps (24 files, +56/−643)

## Deleted (19 commands)

Each re-checked before deletion: no caller in `src/`, `mobile-web/src/`,
`src-tauri/src` (MCP servers, `mobile_control`, `core_dispatch`), `src-core`,
`src-gateway`, `src-serverd`, `scripts/`, docs/help; no template-built
`invoke(\`…\`)` names anywhere. None had a `model_allowlist` row.
For each: `#[tauri::command]` fn, `lib.rs` registration, `command_class` row,
`commandClasses.ts` row (regenerated, 19 rows out).

| Command | Module | Notes |
|---|---|---|
| `check_pid_alive` | `commands/apps.rs` | `pid_alive` kept (used by the registry prune); the unit test `pid_zero_is_never_alive` retargeted to `pid_alive(0)` instead of deleted (it covers a live function) |
| `restore_open_apps` | `commands/apps.rs` | `services::restore_service` keeps the real restore path |
| `copilot_project_policy`, `copilot_stop` | `commands/copilot.rs` | |
| `hpc_ws_release` | `commands/hpc_ws.rs` | |
| `list_installable_models` | `commands/ollama.rs` | + its now-unused `pub struct CatalogEntry` |
| `list_ollama_models` | `commands/ollama.rs` | + `installed_model_names()` (only it used it); `installed_model_names_within` (model_allowlist) kept, doc merged |
| `ollama_is_running`, `ollama_registry_size` | `commands/ollama.rs` | `ollama_listening`/`fetch_registry_manifest` still used; comment that named the two fixed |
| `local_tmux_list` | `commands/terminal.rs` | `parse_tmux_ls`/`local_tmux_ls_args` still used by `tmux_local` |
| `mobile_prepare_phone_install_script` | `commands/mobile_control.rs` | + `INSTALL_PHONE_SCRIPT{,_NAME}` consts; the script's existing unix test now includes `install_phone.sh` itself (see Flagged) |
| `remote_connected_ids` | `commands/remote.rs` | its rationale doc moved onto `remote_connected_targets`; `services::remote::connected_ids` kept (net_usage) |
| `set_box_relations` | `commands/boxes.rs` | `BoxRelation` import dropped; `relations` field still round-trips |
| `spell_languages` | `commands/spell.rs` | |
| `switch_project_windows` | `commands/workspace.rs` | removed from dispatch (lib.rs) + the "replaces switch_project_windows" comment |
| `vm_blocked`, `vm_unpushed_commits` | `commands/vm.rs` | `blocked_report` still used by the VM status |
| `workspace_name`, `workspace_switch` | `commands/workspace.rs` | unused `AppHandle`/`Emitter`/`window_service` imports dropped |

Kept: none of the 19 had a caller. (`save_project` was already gone, decision #1.)

## Also

- `commands/connect.rs`: 8 bare `#[tauri::command]` → `#[cfg_attr(feature = "desktop", tauri::command)]`.
- Deps removed from `src-tauri/Cargo.toml`: `chrono-tz`, `idna`, `ipnet` (no use
  in src-tauri src/tests/examples/build.rs; `mail_sanitize.rs` mentions none of
  them). Their rationale comments moved to `src-core/Cargo.toml`, which does use
  them. `Cargo.lock`: only the 3 lines in the `tabtivity` package's dependency list.
- Docs: `DOCUMENTATION.md` rows `list_ollama_models`, `list_installable_models`
  and `set_box_relations` (box command list) dropped. No `filemap_*.md` row named
  any of them. `docs/filemap_rationale/backend.md` (frozen) still names
  `hpc_ws_release`/`spell_languages` in prose — left, per "frozen".
- TODO text that named removed commands updated: `TODO.md` (R #64 quick-win line),
  `todo/group-h-crossplatform.md` (30c), `todo/group-i-runtime.md` (header),
  `todo/group-a-boxes.md` (relations; a surfacing UI should add a `BoxPatch`
  field, not resurrect the whole-list setter), `todo/group-g-remote.md` (VM
  Phase 5: the open "surface unpushed commits in the pill" item now says
  restore the command from `2f0569c5` with its caller).

## Gates

`scripts/gates.sh` (selected every gate except none — src-core + src-tauri +
Cargo.lock + frontend reached all crates): all PASS — brand, whitespace,
lint-fe, clippy (app-core/app-gateway/tabtivity/app-serverd --all-targets
-D warnings), clippy-dlib (--no-default-features --lib), clippy-dmn
(app-serverd --all-targets), build (tsc 7 + bundles), vitest --changed,
cargo test (4 crates), test-dlib (daemon build + server_secrets). The gate
logs were cleaned up before I could pull exact test counts; the lib test
binary holds 4089 tests (the regeneration run: 1 passed, 4088 filtered).
`commandClasses.ts` regenerated with `UPDATE_COMMAND_CLASSES=1` (19 rows out)
and its `the_generated_command_classes_ts_is_current` test passes.

## Cross-checks

All exit 0 with no warnings:
- `RC=…rc-shim AR_x86_64_pc_windows_msvc=…lib-shim cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -- -D warnings`
- the same shims, `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc`
- `cargo check --workspace --all-targets --target aarch64-apple-darwin` (ci-local's check-only CC/AR stand-ins)
Daemon: built and clippy'd by the clippy-dmn/test-dlib gates (no new deps, only removals; ldd not re-run).

## For merge

- M4d's new `admin` command: its `command_class` row goes in at the tip, then
  `UPDATE_COMMAND_CLASSES=1 cargo test -p tabtivity --lib -- the_generated_command_classes_ts_is_current`.
- M4a noted `ollama_models_dir_plan` (classed `core`, acts on the server-wide
  Ollama dir); class unchanged here per plan — left for a later class review.

## Flagged for user

- `scripts/install_phone.{sh,ps1}` are now reachable by nothing in the app
  (they already were since `af81a0df` replaced the phone-install tab with QR
  pairing; the command was the last link). The `.sh` stays covered by its unit
  test; the `.ps1` by nothing. Delete both (plus their `brand-check.sh`
  entries and the orphaned `.mobile-phone-install*` rules in
  `src/styles/settings-chrome.css`), or re-wire an install action — your call.
- `vm_unpushed_commits`, `hpc_ws_release`, `set_box_relations` were planned
  surfaces never wired (open TODOs). Removed per decision #10; TODOs say how to
  bring them back.

Not run live (backend-only removals; no UI change). After landing:
`npm run backend:stale`.

---

## Handoff M6 — repo/CI (screen Medium plan)

Branch `screen-med-m6` (worktree `.claude/worktrees/med-m6`), from develop `2f0569c5`.

## Commits
- `7e91b9fa` fix(repo): content-derived phone cache name, lockfile in the version bump, daemon clippy on all targets
- `04d074d2` fix(bump-version): rewrite the version files in place, not by mv (sibling bug found while there)

## What changed
- `.github/workflows/ci-cd.yml` "Lint daemon crate": `cargo clippy -p app-serverd --all-targets -- -D warnings`.
  `continue-on-error` on the Windows/macOS clippy jobs untouched (decision #2).
- `scripts/ci-local.sh`: **no edit needed**. That step is kind `ci`: ci-local executes ci-cd.yml's own
  `run:` text, read at run time, and matches steps by `name:` (unchanged). `scripts/ci-local.sh --check-drift`
  passes (23 run, 30 allowlisted, 53 in all). `scripts/gates.sh` `clippy-dmn` already had `--all-targets`.
- `docs/start-tabtivity-tauri-hotreload.sh` deleted. `docs/guide/building.md` points at the root
  `./start-tabtivity-tauri-hotreload.sh`. `docs/root_cleanup_plan.md`: that bullet marked "Done (2026-10-15, screen Medium M6)".
- #11 phone SW cache name: `vite.mobile.config.ts` lost both `define`s plus `headCommit()` and its
  `execFileSync` import (no other user). In their place is a comment. `mobile-web/src/buildInfo.ts`: `entryHash(scripts)` reads
  `/assets/index-<hash>.js` off the page's `script[src]`s (same regex as `stampServiceWorker`), 8 chars;
  `BUNDLE_VERSION` = `v<version> · <hash8>` (just `v<version>` under the vite dev server).
  `formatBuildStamp` is gone. `formatBundleVersion(version, hash)` now takes 2 args.
  `docs/help/mobile.md` (splash version paragraph) updated to match.
- Tests: `src/__tests__/mobile/MobileSwCacheName.test.ts` (new) builds the phone bundle twice (vite CLI,
  scratch outDirs in os tmpdir) and asserts the same `sw.js` cache name and entry. Each build takes about 3 s, so the test about 8 s.
  Mutation-checked: re-adding a `new Date()` define fails it. `MobileBuildStamp.test.ts` was renamed to
  `MobileBundleVersion.test.ts` (entryHash + formatBundleVersion).
- `package-lock.json` root version synced 0.2.9 → 0.2.12 (top + `packages[""]`).
  `scripts/bump-version.sh` bumps both copies **in place with awk** (no jq re-serialisation of 8k lines)
  then verifies with `jq -e` (fails the bump otherwise). A dependency at the same version is not touched.
  An absent lockfile is not an error.
- `.githooks/pre-push`: `bump_files` gains `package-lock.json` (between package.json and Cargo.toml).
  The private-index commit, the uncommitted-edit refusal, `restore_version_files` and the `bump_failed` rollback all iterate
  `bump_files` and are otherwise unchanged. Its comments now say "five". `docs/context/git_push_mcp.md:84` likewise.
- `src/__tests__/git/PrePushPreflight.test.ts`: the throwaway repo has an npm-format lockfile. Assertions:
  root bumped in both spots, dep unchanged, byte-exact npm formatting, bump commit = 5 files, rollback restores it,
  new case "counts package-lock.json among the version files" (an uncommitted edit makes the hook refuse), and every bumped file keeps
  mode 644. Mutation-checked: dropping the lockfile from `bump_files` fails 5 of 6.
- Sibling bug fixed (`04d074d2`): bump-version.sh did `mktemp` + `mv` over each version file, so every
  bump left them **0600** (the main checkout's `package.json` is 600 right now). It now uses `overwrite()` (cat in place).

## Gates (all in the worktree)
- `scripts/gates.sh` (frontend selected): brand, whitespace, lint-fe, build, vitest --changed: all PASS (run after each commit's content).
- Ran directly: the 3 touched test files pass, and eslint on the touched TS files is clean.
- `npm run mobile:bundle` OK. `scripts/brand-check.sh` OK. `scripts/privacy-check.sh` OK (also as pre-commit). `scripts/ci-local.sh --check-drift` OK.
- No Rust touched, so no cargo gate selected. I did not run `cargo clippy -p app-serverd --all-targets` here; it is
  the same command as gates.sh `clippy-dmn`, which develop already passes. **The merged tip's `gates.sh --all` covers it.**
- Not run live. `npm run backend:stale` was not needed (no `src-tauri/` edit). `docs/help/*.md` is embedded by build.rs, so the
  running binary shows the old help paragraph until a rebuild.

## Merge notes
- `vite.mobile.config.ts`: my hunks are the top `execFileSync` import line, `headCommit()` (between
  `themedManifests` and `defineConfig`) and the `define` block. M1 edits `stampServiceWorker` (and may add imports at the
  top, which could need a trivial conflict resolution on the import lines). The `stampServiceWorker` doc comment says "a per-build name";
  it is now per-bundle. That is M1's region, so it is worth a one-word fix there.
- `package-lock.json`: if develop's version moves before merge, re-sync with `scripts/bump-version.sh <package.json version>`
  (an idempotent no-op on the other files).
- `docs/root_cleanup_plan.md` carries an uncommitted edit in the main checkout (line ~220, another session); mine is ~:189. They do not overlap.

## Rows for hot shared files (coordinator to apply)
- `src/lib/untested.ts`: update the `what` text of two existing rows (behaviour changed; still untested):
  - `mobile.lock.version`: `LocalUnlock · The lock sheet (and the once-only PIN setup) ends with "{app} Mobile v0.1.x · <8-char bundle id>", the version and the entry chunk's hash read off the page's script URL`
  - `mobile.version.commit`: `Home · The version line under {app} (and the splash and lock sheet) shows v0.1.x · <8-char bundle id> — the entry chunk's hash, unchanged across rebuilds of an unchanged phone bundle, new after a refresh that picked up new code`
  (Spell the name as the register's other rows do; they currently say "Tabtivity" literally.)
- Filemaps: no rows exist for the touched files; none needed.
- i18n: no new keys.

## Click-through (not run live)
1. After the next `npm run mobile:bundle` + rebuild: the phone's splash / lock sheet / Home header shows `v0.2.x · <8 chars>`.
   Those 8 chars equal the start of `/assets/index-<hash>.js` in DevTools.
2. Rebuild the phone bundle without code changes: the version line and the SW cache name (`tabtivity-mobile-shell-<hash>`) stay the same,
   and the phone does not re-download.

## Flagged for user
- The phone's version line no longer shows the commit or build time (decision #11, as reviewed). It shows the entry hash instead.
- `continue-on-error` on the Windows/macOS clippy jobs is still in place (decision #2, your call).
- The new cache-name test adds about 8 s (two vite builds) to `npm test`, on all three CI OSes.

---

## Handoff — M7 small dedupes (screen 2026-10-15 medium plan)

Branch `screen-med-m7` (worktree `.claude/worktrees/med-m7`), from develop `2f0569c5`.
Commit: `af21408c` (one commit, noreply author) — "refactor(viewers,agents): one disk-reload poll, one agent CLI table".
No i18n keys needed (no new display strings). No untested.ts row (no new UI).

## What changed

### `useDiskReloadPoll` (#3) — `src/lib/useDiskReloadPoll.ts` (new)
- Built on `startPoll` (`lib/usePoll.ts`): in-flight guard, cadence, hidden-window
  pause + catch-up on show, pane gate via `usePaneVisible()`.
- `usePoll.ts` gained one option, `onBlur: "pause" | "widen"` (default `"pause"`,
  so every existing poll is unchanged). `"widen"`: while the window is blurred the
  poll runs at the Energy-Saver cadence (×3) instead of stopping; a hidden window
  still pauses; refocus runs the catch-up if due. This is exactly the one good
  copy's `saverInterval(RELOAD_POLL_MS, quiesce)` semantics (live preview on a
  second screen keeps following the file), now with in-flight guarding.
- API: `useDiskReloadPoll(path, scope, onChange, { enabled, seed, immediate, baseline })`
  → the baseline ref. `seed` (default true) reads the baseline on path/scope
  change, visible or not; `baseline` lets a caller own the ref (its load/saves
  write it); `immediate` is read at start (changing it does not restart);
  `onChange` is read through a ref (a new closure does not restart the poll).
- **Counted 8 copies, not 7**: GifView, OdtView, FileViewerPane ×3
  (`useEditableFile`, `useReadonlyFile`, `useBlobUrl`), PdfPresentApp, PdfViewer,
  and DeckView's sidecar poll (`deckMtimeRef`). All 8 converted. NOT converted:
  DeckView's TeX-figure poll (one stat per figure per tick over a list, with
  per-figure busy/refuse state — a different shape, not a single-file poll).
- Behaviour deltas (deliberate, all in the "safer" direction):
  - Every converted viewer now widens while unfocused / under Energy Saver and
    pauses while the window is hidden (before: only `useEditableFile` widened;
    six ran at full rate always). PdfPresentApp (projector window) widens to
    4.5 s while unfocused, if its window runs focus tracking.
  - Change test is `mtime !== baseline` (was `>` in 7 copies; DeckView already
    used `!==`): a pull/checkout that sets an OLDER mtime now reloads, and a
    baseline ahead of disk no longer blinds the poll for good.
  - With `seed: true` a poll that finds no baseline (the seed read failed, e.g.
    a reconnecting remote) adopts the mtime it saw — before, a failed seed
    disabled auto-reload for that tab forever. Callers with `seed: false`
    (editor, PdfPresentApp, DeckView) keep "no baseline → report nothing".
  - Odt/readonly/editor: the poll no longer restarts (with an immediate stat) on
    every content change — only on gate/path/visibility changes.

### One agent CLI list (#3 review) — backend registry is the authority
- `commands/agents.rs` `AgentSpec` gained `resume: Resume` (`No` | `Args(&[..])`,
  `"{sessionId}"` placeholder). Values are exactly the old `RESUMABLE_AGENTS`.
- **Registry order changed**: `vibe` moved from after Cline to after Gemini, so
  the registry order equals the + menu's old `AGENT_ITEMS` order. Reason: the
  + menu order feeds the Ctrl+1–9 agent chords (`agentShortcutSlots`, when no
  `agent_order` is saved) — keeping the menu order keeps users' chords. The
  side effect: Manage CLIs / `list_agents` now lists Mistral 3rd-after-Claude
  (after Gemini) instead of after Cline.
- Generated `src/lib/agents/agentCliTable.ts` (rows id/bin/label/resume) from
  `agent_cli_table_ts()`; test `the_generated_agent_cli_table_ts_is_current`;
  regenerate: `UPDATE_AGENT_CLI_TABLE=1 cargo test --manifest-path src-tauri/Cargo.toml -q --lib -- the_generated_agent_cli_table_ts_is_current`.
- Hand-written `src/lib/agents/agentClis.ts`: `AGENT_BINS`, `RESUMABLE_AGENTS`
  (now null-prototype, so `"toString" in RESUMABLE_AGENTS` is false),
  re-exports `AGENT_CLI_ROWS`.
- `stores/tabs.ts` (my region only): `AGENT_CMDS` and `RESUMABLE_AGENTS` removed;
  `cmdToKind` uses `AGENT_BINS`. The import sits **inside the region** (ES
  imports hoist) so M3's import list is untouched — the main agent may move it
  to the top after merging M3. `RESUMABLE_AGENTS` is no longer exported from
  the store; its importers were switched: `newTabItems.ts`, `MobileBridgeHost.tsx`,
  `stores/agents/agentClearUndo.ts`, `stores/agents/closedAgentTabs.ts`
  (one import line each). If M3 (or anyone) adds a new `RESUMABLE_AGENTS`
  import from `stores/tabs`, point it at `lib/agents/agentClis`.
- `newTabItems.ts`: `AGENT_ITEMS` = registry rows + `AGENT_ITEM_EXTRAS`
  (Claude's `sessionRename`/`sessionIdArgs`, Gemini's `sessionIdArgs`);
  no longer imports from the store for `RESUMABLE_AGENTS`.
- `lib/usageMetrics.ts` `AGENT_LABELS`: registry labels + 4 retired leaves
  (`kiro`, `openhands`, `mentat`, `gpte`).
- **Found sibling copies (fixed, same bug class):**
  - `services/terminal_service.rs` `AGENT_CMDS` (the restore allow-list for
    persisted layouts) was a 13-entry hand copy — so a saved Kiro/Goose/Amp/…
    tab was rewritten by the backend sanitizer to `cmd: ""` "restoring it as a
    plain shell". Now `agent_cmds()` = `agent_bins()` + `ollama`. Security note:
    this widens the persisted-layout allow-list from 13 to all 30 registry
    agent CLIs (+ollama); they are the same class (registry agent binaries,
    fenced like the 13 already allowed) and exactly what the frontend writes.
    M4c touches this file's `FileLock` lines only — different hunks.
  - `services/mobile_control/discovery.rs` `RESUMABLE_BUILTINS` const → 
    `resumable_builtins()` from the registry (phone agent list now in registry
    order: claude, codex, agy, gemini, vibe, opencode, cursor-agent, copilot,
    droid, grok, qwen — was claude, codex, qwen, opencode, …).
  - `services/mobile_control/headless.rs` `resume_args` match → registry.
  - Stale comments in `services/sandbox.rs` (mentioned the frontend's
    `AGENT_CMDS`), `docs/context/agent_sessions.md` updated.

## Tests added
- `src/__tests__/viewers/DiskReloadPoll.test.tsx` (9): change reported once +
  baseline moved; older mtime is a change; hidden pane: seeded but no polling,
  immediate check on show; blurred widens ×3, hidden window stops, catch-up on
  return; unmount stops; `enabled` gate; `seed: false`; caller-owned baseline;
  `immediate: false`; new `onChange` closure does not restart.
- `src/__tests__/system/UsePoll.test.tsx` +1: `onBlur: "widen"`.
- `src/__tests__/viewers/ViewerDiskReload.test.tsx` (2): `useReadonlyFile` and
  `OdtView` still reload (no prior test). Editor/image/GIF/PDF keep their
  existing reload tests (`AutoReload`, `ImageAutoReload`, `GifView`,
  `PdfReloadSettle`) — all pass. PdfPresentApp and DeckView's sidecar poll have
  no component test (heavy windows); their semantics (`seed:false`,
  `immediate:false`, caller baseline) are covered by the hook tests.
- `src/__tests__/agents/AgentCliTable.test.ts` (5): every registry bin →
  `cmdToKind` "agent" (regression: kiro-cli/cline/goose/amp/cn/muse); a
  kind-less saved goose/kiro tab loads as an agent, droid with its resume args;
  `AGENT_ITEMS` = rows in order with extras; `RESUMABLE_AGENTS` derivation;
  usage labels.
- Rust: `the_generated_agent_cli_table_ts_is_current`,
  `resume_args_come_from_the_registry` (agents.rs);
  `every_registry_agent_restores_as_itself_not_as_a_shell` (terminal_service.rs).

## Gates
`scripts/gates.sh` (touched: frontend + src-tauri), all PASS: brand, whitespace,
lint-fe (no new warnings in touched files), clippy (tabtivity + app-serverd,
all targets), clippy-dlib, clippy-dmn, build, vitest --changed, cargo test
-p tabtivity -p app-serverd, test-dlib. Full `npx vitest run`: **849 files,
8582 tests passed**. Not run live. No `src-tauri` hot reload: after landing,
`npm run backend:stale` (backend change: registry `resume` field, restore
allow-list, phone resumable set). The post-commit hook printed an unrelated
"embedded mobile PWA is stale" notice (M7 changes nothing in mobile-web).

## Filemap rows (for the main agent to add)
- `docs/filemap_frontend.md`, next to `lib/usePoll.ts`:
  `| \`lib/useDiskReloadPoll.ts\` | The file viewers' one "changed on disk?" poll (#43): \`useDiskReloadPoll(path, scope, onChange, {enabled, seed, immediate, baseline})\` on \`startPoll\` with \`onBlur: "widen"\` — visible panes only, ×3 while unfocused/Energy Saver, paused while the window is hidden, catch-up on show; \`mtime !== baseline\` → \`onChange\`. Used by Gif/Odt/FileViewerPane (editor, read-only, image)/PdfViewer/PdfPresentApp/DeckView sidecar. Test: \`viewers/DiskReloadPoll.test.tsx\`. |`
- `lib/usePoll.ts` row: append "`onBlur: "widen"` keeps a quiesced poll running at the saver cadence while blurred (still pauses when hidden)."
- `docs/filemap_frontend.md`, `lib/agents/`:
  `| \`lib/agents/agentCliTable.ts\` / \`agentClis.ts\` | GENERATED from \`commands/agents.rs\` \`AGENTS\` (\`UPDATE_AGENT_CLI_TABLE=1 cargo test … the_generated_agent_cli_table_ts_is_current\`): every built-in agent CLI's id/bin/label/resume args. \`agentClis.ts\` derives \`AGENT_BINS\` (\`cmdToKind\`), \`RESUMABLE_AGENTS\`; \`newTabItems.AGENT_ITEMS\` and usage labels read the rows. Test: \`agents/AgentCliTable.test.ts\`. |`
- `docs/filemap_backend.md`, `commands/agents.rs` (if it has a row): "…`AgentSpec.resume` + `agent_cli_table_ts()`: the one agent CLI list (frontend table, `terminal_service` restore allow-list, phone resumable set)."

## Click-through (not run live)
1. Open a `.png`, `.gif`, `.odt`, `.ipynb`, a `.md` and a `.pdf` in viewer tabs.
   Overwrite each from a terminal (`cp other.png fig.png`, `touch`+edit the md,
   recompile the PDF). Each viewer updates within ~1.5 s.
2. With the md tab visible, click into another app (window unfocused), edit
   the file externally: it updates within ~4.5 s (widened, not stopped).
3. Put the md tab behind another tab, edit the file, switch back: it updates
   at once.
4. Make the md buffer dirty, edit the file externally: the "changed on disk"
   banner appears, buffer untouched.
5. Deck view: open a `.deck` in two tabs, save in one: the other reloads
   (notice) or holds if dirty. Present a PDF (projector window), recompile:
   the projector sheet updates.
6. Agents: install/open a Goose (or Kiro/Amp) tab and a Droid tab; quit and
   relaunch. Droid comes back resuming; Goose is not brought back as a plain
   shell tab running `goose`. The + menu order and Ctrl+1–9 numbers are
   unchanged; Manage CLIs now lists Mistral right after Gemini.

## Flagged for user
- Manage CLIs order: Mistral moved up (after Gemini) so the registry order
  equals the + menu order (which drives Ctrl+1–9). Alternative: keep the
  registry order and let the + menu follow it (changes chords). Chose chords.
- Restore allow-list widened from 13 to all 30 registry agent CLIs (+ollama)
  — the fix for "restores as shell"; same class of binary as the 13 already
  there.
- Non-resumable agent tabs (Goose, Kiro, …) are, by design, still not restored
  across a restart (no resume flag); the fix is that they no longer come back
  as a shell. Adding a `resume` to their registry rows would make them resumable.
- DeckView's TeX-figure poll left on its own `setInterval` (multi-file shape).

---

## Final review — Mediums run (screen 2026-10-15), branch `screen-med-int`

Reviewed `git diff 2f0569c5..screen-med-int` (all ten steps + step reviewers'
fixes), plan incl. "Plan review" and "Decision change". Closest read: M1, M2,
M4c, M5, M6, M7; integration across M3/M7, M1/M6, M4b/M4c, M4a/M4d, M5.

## Fixed (commits on screen-med-int)

- `ca750547` fix(dispatch): M4a's `USER_CONFINED` table still had two rows for
  `hpc_ws_release`, which M5 deleted → the merged tip failed
  `every_path_named_core_argument_is_classified` ("not a core command").
  Rows dropped; that existing test is the regression test (failed before,
  passes after).
- `dbd9040c` fix(skills): AGENTS.md invariant (M4a verifier's finding) —
  `SkillTarget::Personal` wrote the user's real `~/.claude/skills`. It now
  resolves to `<state_dir>/agent-global/.claude/skills`
  (`agent_global::global_dir()`), the Tabtivity-wide layer that
  `apply_to_home` copies into every agent home at each spawn (and removes
  from homes when a file leaves the layer, so uninstall works). Regression:
  `target_skills_dir_resolves_both_scopes` asserts the layer path and that it
  is not `~/.claude/skills` (fails on the old code). Docs/comments
  (`schema/skills.rs`, `commands/skills.rs`, `core_dispatch` SkillTarget
  kind, `web_client.md`, help `agent-clis.md`, guide `features.md`,
  `SkillsTarget.test.ts` header) and the UI note + lesson text
  (`skillsLibrary.scopePersonalNote`, `lessons.skillsLesson.scopeBody`) in all
  five languages. Role-user refusal of the personal target (M4a) kept.
- `179c9d57` chore(merge): hot-file rows (below), M7's parked import moved to
  the top of `stores/tabs.ts`, `stampServiceWorker` comment says per-bundle.
- `2ede9e1f` test(mobile): the first gate run failed vitest with 8 unhandled
  rejections (all 7085 tests passing) from `MobileSessionPrompts.test.tsx`:
  agentModels' 2.5 s turn-start recheck (armed by beforeEach's busy edge)
  fired after afterEach reset the invoke mock to answer `undefined`. The mock
  now answers later calls with a settled promise. Pre-existing (neither file
  touched in this run), load-dependent; checked by appending a 3.5 s test:
  old afterEach → 12 unhandled errors, new → none.

## Hot-file items applied

- `src/lib/untested.ts`: `mobile.lock.version`, `mobile.version.commit` texts
  (M6). Not added: M1's `phone-push-title-language` and M2's `todo.nameSheet`
  — register-only rows fail `UntestedRegistry.test.ts` ("a row no call site
  uses"), and both handoffs left them optional. M4d rows: dropped by the
  rework (none present — verified).
- `docs/filemap_frontend.md`: rows for `mobile-web/src/pushTitles.ts`,
  `mobile-web/src/components/ConfirmSheet.tsx`, `lib/useDiskReloadPoll.ts`,
  `lib/agents/agentCliTable.ts`/`agentClis.ts`; `lib/usePoll.ts` row gains
  `onBlur: "widen"`; skills view row (personal scope).
- `docs/filemap_backend.md`: `storage.rs` (FileLock fallback), `sysstat.rs`
  (`process_start`), `core_dispatch.rs` (`USER_CONFINED`), `mobile_control/`
  web_client sentence, `services/skills.rs` (personal scope).
- `mobile-web/src/style.css` comment: version line shows the entry hash.
- i18n: M2 (3) and M3 (3) keys present in en + de/es/fr/it (checked by key);
  M4d's five keys absent everywhere (removed with the rework); M1 keys present.
  The i18n parity tests (every key in every language, no extra keys,
  placeholders both ways) pass in the vitest gate.
- `commandClasses.ts` and `agentCliTable.ts` generators pass without UPDATE
  (`the_generated_command_classes_ts_is_current`,
  `the_generated_agent_cli_table_ts_is_current`).

## Integration checked

- M3 × M7 `stores/tabs.ts`: M7's import was parked mid-file; moved to the
  import list. All `RESUMABLE_AGENTS` importers point at `lib/agents/agentClis`.
- M1 × M6 `vite.mobile.config.ts`: M1's push-title stamping and M6's removed
  `define`s/`headCommit` merged cleanly; cache name is the entry hash only.
- M4b × M4c `remote_sync.rs`: `save_manifest_at` takes
  `exclusive_or_unlocked` (it has the stamp CAS), `update_manifest` plain
  `exclusive` (propagates); `mark_stale_on_disk` writes through
  `save_manifest_at`, so it inherits the lockless fallback + CAS. Consistent.
- M4a × M4d `credentials.rs`/`core_dispatch.rs`: after the decision change,
  `Role` is back in `core_dispatch`, `CoreCtx` has no role, no
  `added_by_client`/approval command/UI left; the stored-spelling argv stays.
- M5 deletions: no remaining reference in src/, mobile-web/src, src-tauri,
  src-core, src-gateway, src-serverd, scripts, DOCUMENTATION.md, current docs
  (only historical review docs and the frozen rationale mention them) — except
  the two `hpc_ws_release` table rows fixed above.
- M3 × M4a `workspace_sync` empty `localFile`: handled (`LocalFileOpt`).

## Flagged for user (not changed)

- Personal skills for a `Role::User` browser client stay refused (M4a). On a
  per-user daemon the agent-global layer is that account's own, so allowing it
  would be reasonable — your call.
- Skills a user installed under the old build sit in `~/.claude/skills` and
  are no longer listed as "personal"; Settings' agent-global import
  (`agent_global_import`, which copies `~/.claude/skills`) brings them over.
  No automatic migration (would read another app's folder unasked).
- `mobile.link.splashVersion` (stamped tested 2026-09-28) still says
  "version and build time" — its behaviour changed with M6 (entry hash);
  re-test or re-word is your call.
- PdfPresentApp (projector window, normally unfocused) now polls at the
  widened 4.5 s while unfocused (M7's `onBlur: "widen"`), was 1.5 s.
- `.githooks/pre-push` now refuses to bump while `package-lock.json` has an
  uncommitted edit (M6) — npm lockfile churn from other sessions will block
  auto-bumps until committed or reverted.
- Carried from step handoffs: M5 `scripts/install_phone.{sh,ps1}` orphaned;
  M7 registry order (Mistral after Gemini) and widened restore allow-list;
  M4c lockless state dirs now fail loudly; M4b umask-applied host modes;
  M3 once-per-session layout toast; M1 "Ok"→"OK"; M2 `DialogShell` backdrop
  swallows presses; M6 +8 s cache-name test; `continue-on-error` on
  Windows/macOS clippy (decision #2).

## Gates (`scripts/gates.sh --base 2f0569c5`, tip 2ede9e1f)

All PASS: brand, whitespace, lint-fe, clippy (app-core, app-gateway,
tabtivity, app-serverd --all-targets -D warnings), clippy-dlib, clippy-dmn,
build (tsc 7 + bundles), vitest --changed, cargo test (4 crates), test-dlib
(--no-default-features --lib + server_secrets). The first run at 179c9d57
failed only vitest on the unhandled rejections fixed in 2ede9e1f.

Also: `scripts/privacy-check.sh 2f0569c5 HEAD` PASS (6807 added lines, 163
paths, 32 commits); `git diff --check 2f0569c5` clean;
`scripts/brand-check.sh` in the gate run. `npm run backend:stale` from this
worktree: running window predates the build and the embedded mobile bundle is
stale (expected — nothing here is live; rebuild + relaunch when convenient).
Windows/macOS cross-checks not re-run: my Rust changes are a path constant
and two table rows, no cfg/spawn/path-literal code. Not run live.
