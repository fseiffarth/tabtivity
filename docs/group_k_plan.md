# Group K #40 — Drag a file into a tab bar to open it as a frameless embedded tab

> **STATUS: staged. Phase 1 approved for implementation now (see "Review Resolution" at bottom). Phase 2 (live X11 reparent) deferred to a separate pass with manual X11 QA.**


## 0. Reality check on "embed inside a tab" (read this first)

The tab content area is a WebKitGTK webview surface, not a native container. You cannot reparent an external X11 client *into* a DOM node. The faithful achievable approach is:

**A positioned native child window owned by Tabtivity's top-level X11 window, reparented to hold the app's top-level, and continuously synced to the panel-relative pixel rect of the tab's pane slot.** Concretely:

- The frontend already measures every group body rect (`groupRects` in `CenterPanel.tsx`, panel-relative px) for the flat pane layer. We reuse that exact rect for an embedded tab and report it (converted to root-window coordinates) to the backend.
- The backend keeps, per embedded tab, an **embed container window** (a child of Tabtivity's GTK/X11 top-level), `XReparentWindow`s the launched app's top-level into that container, and maps/positions both to track the reported rect.
- On tab switch/hide we `XUnmapWindow` the container; on show we `XMapWindow` + reposition; on resize we `ConfigureWindow` both container and child; on close/move-away we reparent the child back to root and kill the app.

**Stacking limitation, called out explicitly:** the embedded native window stacks *above* the webview (it's a sibling/child in the X tree, not in the DOM). While an embedded tab is the active tab of its group it covers that group's pane rect — desired — but it will also paint over any DOM overlapping that rect: drag ghosts, the split-preview overlay, context menus, the right-panel overlay. Mitigation: while a tab drag is in progress or the right panel is open over the center, **unmap all embed containers** and remap them when the interaction ends. This is the biggest correctness risk; handled in step F below. True in-webview compositing is infeasible with WebKitGTK; this positioned-child approach is the standard XEmbed-style fallback.

Everything is Linux/X11-only. On Wayland-KDE, null, Windows, macOS the capability check returns false and the feature degrades to the existing external `open_file` launch with no tab-bar drop target.

---

## 1. Capability check

**Backend command** (new), in `src-tauri/src/commands/apps.rs`:

```
#[tauri::command]
pub fn embed_capability(path: String, handler: Option<String>) -> EmbedCapability
// { os_embeddable: bool, app_embeddable: bool, resolved_exec: Option<String> }
```

- `os_embeddable`: true only when the active workspace backend is X11. Add `fn supports_embedding(&self) -> bool { false }` to `WorkspaceBackend` (`platform/mod.rs`), override `true` only in `platform/x11.rs`. Read from managed workspace state. Also gate on `std::env::var("WAYLAND_DISPLAY").is_err()` to avoid XWayland surprises.
- `app_embeddable`: resolve default app exec, check against `const EMBEDDABLE_EXECS: &[&str]` (basename) of apps with a single stable top-level window (e.g. `xterm`, `mousepad`, `gedit`, `kate`, `okular`, `evince`, `eog`, `feh`, `mpv`). Exclude Electron/multi-window/fork-and-exit apps. Heuristic; document it.
- `resolved_exec`: the exec we'd embed.

**App resolution:** add `resolve_default_handler(path, handler) -> Option<String>`: (1) passed handler; (2) project `default_apps` then global `default_apps.json` (reuse `DefaultApps::get`); (3) `xdg-mime query default <mime>` → `.desktop` → `Exec` first token (reuse `first_exec_token` apps.rs:602 + `parse_desktop_entry`).

**Frontend gate:** lazy capability query on file drag start (§3); tab-bar drop target only activates when `os_embeddable && app_embeddable`. Cache per `(ext|path, handler)`.

**Fallback:** when unsupported, no tab-bar drop target; existing click→`openFile` external is unchanged.

---

## 2. Backend (Rust)

### 2a. X11 primitives — `src-tauri/src/platform/x11.rs`
Reuse `intern_atom` (x11.rs:329), `window_from_u64` (x11.rs:107), `MapWindow`/`ConfigureWindow` (x11.rs:115/118). Add (prefer a dedicated `EmbedManager` connection):
- `create_embed_container(conn, parent, rect) -> Window`
- `reparent_into(conn, child, container)` — ReparentWindow + MapWindow at (0,0)
- `configure_embed(conn, container, child, rect)`
- `set_embed_visible(conn, container, bool)`
- `release_embed(conn, child, root, container)` — reparent child back to root, DestroyWindow container

**Tabtivity top-level XID:** in `lib.rs` `setup`, fetch GdkWindow → XID of main window, store in managed `EmbedManagerState`. Recommend parenting containers to Tabtivity top-level (z-order + auto-cleanup on exit). Open question for reviewer: parent choice.

### 2b. Embed lifecycle — new `src-tauri/src/services/embed.rs` (mirror `services/ssh_mount.rs`)
```
struct EmbeddedApp { tab_key, scope, pid, app_window, container, exec, file }
struct EmbedManager { conn, tabtivity_xid, embeds: HashMap<"scope:tabkey", EmbeddedApp> }
type EmbedManagerState = Arc<Mutex<EmbedManager>>;
```
Functions: `embed_open`, `embed_set_geometry`, `embed_set_visible`, `embed_close`, `embed_close_all_for_scope`, `embed_suspend_all`/`embed_resume_all`.

### 2c. Commands — `src-tauri/src/commands/apps.rs` (or new `commands/embed.rs`)
- `embed_open(path, handler, project_id, scope, tab_key, rect) -> TrackedWindow`: spawn resolved exec (origin `ORIGIN_EMBEDDED_TAB`), `find_window_for_pid` (apps.rs:810), create container + reparent + configure; track in `WindowRegistry` + `EmbedManager`.
- `embed_set_geometry(scope, tab_key, rect)` — frontend sends absolute screen coords.
- `embed_set_visible(scope, tab_key, visible)`.
- `embed_close(scope, tab_key, kill=true)` — release_embed + SIGTERM pid; untrack.
- `embed_suspend_all` / `embed_resume_all(scope)` — unmap/remap containers.
Add `ORIGIN_EMBEDDED_TAB` const (near apps.rs:42-46).

### 2d. Lifecycle / leak avoidance
- App exit: parent-to-Tabtivity-top-level → X destroys containers on Tabtivity window death; also `embed_close_all` in app exit/cleanup. Kill pids to avoid zombies. Recommend kill (tabs non-restorable §4).
- App self-exit: reaper thread per embed waits on pid, emits `embed-exited {scope, tabKey}`; frontend removes tab.
- Tab moved to another group: same embed, new rect — just `embed_set_geometry`.

### 2e. Registration: add commands to `generate_handler!` (lib.rs:185+), `.manage(embed_manager)` (lib.rs:176-179).

---

## 3. Frontend

### 3a. Tab kind — `src/stores/tabs.ts`
- Line 4: add `| "embed"`. Extend `TabEntry` with `embedPath?`, `embedExec?`. Add accent in `TAB_ACCENT` (TabBar.tsx:16). `isRestorableKind` excludes embed; do NOT add to agent branch.

### 3b. Drag source — `src/components/files/FileTree.tsx`
Keep existing HTML5 DnD (FileTree.tsx:195-206, 438-439). Add pointer-based drag mirroring `onTabPointerDown` (TabBar.tsx:221-274): on threshold cross, `startFileDrag({path,name,mime})`, prefetch `embed_capability`. Bind move/up on window inside pointerdown (WebKitGTK reason, TabBar.tsx:258-265). Avoid native DnD hijack on WebKitGTK. Open question: coexistence / modifier / drag handle.

### 3c. Drag store — `src/stores/drag.ts`
Add `kind: "tab" | "file"` discriminant + `embedCap` fields. For file drag in `CenterPanel.tsx` `resolve` (CenterPanel.tsx:214-246), only set `reorderGroup` over a tab bar (capability passed); ignore edge/split targets.

### 3d. Drop — `src/components/tabs/commitDrop.ts` (or new `commitFileDrop.ts`)
On file drag with valid target + capability OK: focus target group, `addTab({label: fileName, cmd:"", kind:"embed", cwd: projectCwd, embedPath, embedExec})` at `reorderIndex`. New pane mounts → `embed_open`. If capability failed, fall back to external `openFile`.

### 3e. EmbedPane — new `src/components/embed/EmbedPane.tsx`; render branch in CenterPanel pane layer (CenterPanel.tsx:344-388)
- On mount (visible): `embed_open(... screenRect)` from `getBoundingClientRect()`.
- On rect/visibility change: `embed_set_geometry` + `embed_set_visible`, debounced via rAF (divider drag floods, CenterPanel.tsx:469-503).
- On unmount/close: `embed_close`. Listen for `embed-exited` → `removeTab`.

### 3f. Geometry: send viewport `getBoundingClientRect()`; backend adds Tabtivity top-level origin (queried via X) → root coords. Math in `services/embed.rs`, unit-tested.

### 3g. Mitigation (stacking): suspend/resume embeds on drag start/end (`useDragStore.drag != null`) and on right-panel open/close (`AppShell.tsx`).

---

## 4. Persistence
**Embed tabs NOT restorable** (matches agent-tab policy, tabs.ts:771-775). `isRestorableKind("embed") === false` → `saveLayout` drops them, `pruneSavedTree` prunes keys, restore filter (CenterPanel.tsx:90-95) already keeps only restorable. No schema change.

---

## 5. Graceful degradation
Non-X11/Wayland/non-allowlisted/unresolvable → capability false. File drag still starts but no accept affordance on tab bars; click still opens externally. Optional: failed-capability drop onto tab bar falls back to external open (recommend yes). Existing native file DnD untouched.

---

## 6. Test plan
**Vitest `src/__tests__/`:**
- `EmbedCapabilityGate.test.ts` — drop target activates only when both flags true; fallback otherwise (mock `invoke`).
- `FileDropAddsEmbedTab.test.ts` — file drop adds one `kind:"embed"` tab labelled after file, at resolved index, no split (mirror `DragDropSplit.test.tsx`/`TabReorder.test.ts`).
- `TabPersistFilterEmbed.test.ts` — extend `TabPersistFilter.test.ts`: embed dropped from save; `isRestorableKind("embed")===false`.
- `EmbedPaneGeometry.test.ts` — geometry math helper (if extracted as pure fn).

**Rust `src-tauri/tests/`:**
- `embed_capability_tests.rs` — `resolve_default_handler` (handler passthrough, project>global precedence, mime fallback via temp `.desktop`); allowlist membership; `supports_embedding()` true only for X11.
- `embed_geometry_tests.rs` — viewport→root coord math (pure arithmetic).

**Not unit-testable (document for manual QA):** real XReparent/map/configure, window-find-by-pid, app launch, stacking. QA: drag `notes.md` onto a tab bar with embeddable default app.

---

## 7. Ordered task list for the coder
1. `supports_embedding()` on `WorkspaceBackend` (`platform/mod.rs`), true in `x11.rs`, false default + null test.
2. `resolve_default_handler` + `EMBEDDABLE_EXECS` in `commands/apps.rs`; tests `embed_capability_tests.rs`.
3. `embed_capability` command; register in `lib.rs`.
4. X11 primitives in `platform/x11.rs`.
5. `services/embed.rs` (`EmbedManager` + state + geometry conversion tested in `embed_geometry_tests.rs`); capture Tabtivity top-level XID in `lib.rs` setup; `.manage`.
6. Embed commands + reaper (`embed-exited`) + cleanup-on-exit; register in `lib.rs`; `ORIGIN_EMBEDDED_TAB`.
7. Tabs store: `"embed"` kind + fields + accent; confirm `isRestorableKind` excludes embed.
8. Drag store: file-drag variant + capability fields.
9. FileTree pointer drag + capability prefetch (don't break native DnD).
10. CenterPanel resolve + `commitFileDrop`: embed tab into target group named after file.
11. `EmbedPane` + CenterPanel branch; geometry/visibility sync; open/close; `embed-exited` listener.
12. Mitigation wiring: suspend/resume on drag + right-panel.
13. All tests from §6.
14. `npx tsc --noEmit` + `cargo test --manifest-path src-tauri/Cargo.toml`. Backend changes need user rebuild/restart for QA; do not launch Tabtivity.

---

## 8. Risks / open questions
1. Stacking/z-order central risk — does global suspend-on-overlay suffice, or per-overlay intersection logic for context menus/modals/project switcher?
2. Tabtivity top-level XID via `with_webview`/GTK — confirm GTK window (not webview child) is reparent target, XID stable post-setup.
3. FileTree native DnD vs pointer drag coexistence on WebKitGTK (pointerup hazard) — modifier or drag handle?
4. App allowlist heuristic — ship conservative, expand later?
5. Kill-on-close/exit policy — always SIGTERM child (possible unsaved-data loss)?
6. Geometry under fractional HiDPI / WebKitGTK device-pixel-ratio — scale factor needed; QA.
7. Reparent timing race — `find_window_for_pid` polls ~2s; apps mapping late/splash; may need WM_STATE-normal wait.

---

## Review Resolution & Phase 1 Cut Line (authoritative for the coder)

Plan reviewer verdict was REWORK→staged. User approved **Phase 1 now**. The coder implements ONLY Phase 1 below. Apply the REQUIRED fixes inline.

### Phase 1 scope (implement now — fully unit-testable, zero X11 reparent risk)
1. **Backend capability:** `supports_embedding()` on `WorkspaceBackend` (default false, true in `x11.rs`); `resolve_default_handler` + conservative `EMBEDDABLE_EXECS` allowlist + `embed_capability` command in `commands/apps.rs`; register in `lib.rs`. Rust tests `embed_capability_tests.rs`.
2. **Tabs store:** add `"embed"` TabKind + `embedPath?`/`embedExec?` fields + accent; `isRestorableKind("embed") === false`; NOT in agent branch.
3. **Drag store (`src/stores/drag.ts`):** add `kind: "tab" | "file"` discriminant + capability fields. (No `kind` field exists today — confirmed.)
4. **FileTree pointer-drag source:** mirror TabBar `onTabPointerDown`; prefetch `embed_capability`.
5. **CenterPanel `resolve`:** accept file drags only over a tab bar (capability passed); ignore edge/split targets.
6. **`commitFileDrop`:** on valid file drop, create the embed tab named after the file in the target group.
7. **EmbedPane (Phase-1 form):** on mount call existing external `open_file` (windows store `openFile`) and render a placeholder pane ("opened externally — live embedding pending"). NO X11 reparent yet. This delivers full drag/drop/capability/tab UX + graceful degradation.
8. Tests per §6 (the testable subset): `EmbedCapabilityGate`, `FileDropAddsEmbedTab`, `TabPersistFilterEmbed`, `embed_capability_tests.rs`.

### REQUIRED fixes (apply during Phase 1)
- **R1 (addTab bug):** `addTab` always appends (tabs.ts:486) and ignores position; it adds to the FOCUSED group and auto-activates. To place at the drop slot: focus the target group (`focusGroup`/`setGroupActive`), `addTab(...)`, then `moveTab(newKey, targetGroup, reorderIndex)` (moveTab honors index, ~621-624). Write the FileDropAddsEmbedTab test to assert the final slot only after this.
- **R5 (visibility):** keep embed commands in `commands/apps.rs` (so they can call private `find_window_for_pid`), OR change its visibility to `pub(crate)`. For Phase 1 (no window-find yet) either is fine — keep in apps.rs.
- **R6 (DnD coexistence — likely blocker):** FileTree rows are `draggable` with `onDragStart` (438-439). The new pointer drag MUST `e.preventDefault()` on pointerdown to suppress native DnD AND disable `draggable`/`onDragStart` for embeddable rows (or gate it), else both fire and WebKitGTK emits `pointercancel`. The commit (`commitFileDrop`) MUST be bound from **FileTree's own pointerdown→window pointerup** (the only listener guaranteed to see pointerup pre-capture), mirroring TabBar/commitDrop — NOT from CenterPanel.
- **Allowlist:** keep `EMBEDDABLE_EXECS` truly conservative (`xterm`, `xev`, `mousepad`, `okular`, `evince`, `eog`, `feh`, `mpv`, `qpdfview`); document the fork-and-exit caveat (gedit/kate/gnome-text-editor are single-instance D-Bus apps — exclude).

### REQUIRED fixes deferred to Phase 2 (note them, don't implement)
- **R2 (stacking mitigation):** wire suspend/resume from a single overlay-count signal covering drag + right-panel + context menus + modals + project-switcher dropdown + SplitPreviewOverlay — not just drag + right-panel.
- **R4 (geometry):** EmbedPane sends `el.getBoundingClientRect()` (viewport CSS px) + `window.devicePixelRatio`; backend queries Tabtivity GTK top-level root origin once and composes to root device px. Do NOT reuse panel-relative `groupRects`. Extract the math as a pure fn (TS + Rust) so geometry tests are meaningful.
- Dedicated xcb connection for `EmbedManager` (avoid workspace Mutex contention during rAF geometry floods).
- `embed-exited` event must carry scope; removal targets the right scope even after project switch.

### Correction to the TODO premise
TODO says "Reuses the embedded-window machinery from the global-apps/windows store." This is misleading: `windows.ts`/`open_file` spawn EXTERNAL top-levels; `x11.rs` show/hide only Map/Configure/desktop-shuffle. There is NO reparent/XEmbed code today — the entire embed layer (Phase 2) is net-new.
