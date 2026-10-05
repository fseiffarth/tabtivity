# Tabtivity — Known Issues

## Open

### ISSUE-001: X11 app embedding untested

**Phase:** 6.B  
**Severity:** Unknown — code written but not verified in a live session  
`show_app_window(xid)` uses `GdkX11.X11Surface.get_xid()` + `XReparentWindow`. This approach may fail if:

- The compositor rejects the reparent
- The embedded window ignores resize requests
- GDK surface is not yet realised when called (widget not yet mapped)

**Workaround:** Falls back to `_raise_window` if center panel ref is missing; but if it raises an exception mid-reparent the center panel may show a blank page.  
**Fix needed:** Test with a real window (e.g. gedit); add error recovery to restore last terminal page on failure.

---

### ISSUE-002: Left panel shows all desktop apps, not project-scoped

**Phase:** 6.C (future)  
All normal windows appear in "OPEN APPS" regardless of which project is active. Should filter to only windows whose process cwd is under `~/tabtivity/<current-project>/`.

---

### ISSUE-009: Right panel gets double width after hide-both → show-left → show-right

**Phase:** Post-Phase 13 (panel toggle polish)  
**Severity:** Medium — visual layout broken in this specific sequence  
When both panels are hidden and then revealed one at a time (left first, then right), the right panel takes roughly double the expected width instead of restoring to its original 220 px.

**Suspected cause:** The `Gtk.Paned` position for the outer pane (left/center split) is restored when the left panel is shown, but this shifts the total available width that the inner pane (center/right split) sees. When the right panel is subsequently shown, the inner pane position is recomputed against the now-shifted outer pane, resulting in the wrong right-panel width.

**Reproduction steps:**

1. Hide both panels (toggle left, then toggle right — or use Super key)
2. Show left panel only
3. Show right panel — observe it is ~440 px wide instead of ~220 px

**Fix needed:** When restoring a panel, recompute the paned position relative to the current window/outer-pane allocation rather than using the saved absolute pixel offset.

---

### ISSUE-008: Open-app embedding completely broken

**Phase:** Post-Phase 13  
**Severity:** High — current implementation is unusable  
The entire "open apps" pipeline (launching a file, detecting the window, embedding it in the center panel) has multiple failure modes and needs to be rewritten in stages:

**Stage 1 — Open file in standalone window (baseline)**

- Remove all X11 reparenting / embedding code from `LeftPanel` and `CenterPanel`
- `_open_file` should simply `subprocess.Popen([app, path])` and record the entry in `project.json["open_apps"]`
- Verify this works reliably before proceeding

**Stage 2 — Embed app fullscreen in center panel**

- Once Stage 1 is stable, define the center panel window ID as the embedding target
- Reimplement `show_app_window(xid)` using `GdkX11.X11Surface.get_xid()` + `XReparentWindow` + `XResizeWindow`; add robust error recovery (restore last terminal page on any exception)
- Add a 300 ms delay after launch before attempting reparent, retrying up to 5 times

**Stage 3 — Wire to the open-apps panel**

- Once Stage 2 is stable, reconnect `AppRow` click → `show_app_window(xid)` in `LeftPanel`
- EWMH poll should track the embedded window's XID and update `AppRow.xid` accordingly

---

### ISSUE-013: Agent numbering does not reset after adding and closing an agent

**Phase:** Agent/session lifecycle polish  
**Severity:** Low to Medium — confusing UI state after normal agent add/close flow  
When a new agent is added and then closed, the visible agent numbers are not reset. Subsequent agents continue from the previous number instead of renumbering or reusing the expected sequence.

**Fix needed:** Recompute agent display numbers after agent removal, or clarify the intended numbering model if numbers are meant to be persistent session IDs.

---

### ISSUE-014: Adding a new agent clears current project selection and hides right panel

**Phase:** Agent/session lifecycle polish  
**Severity:** Medium — adding an agent disrupts the active project workspace  
When a new agent is added, the active project should remain unchanged. Instead, the bottom project switcher no longer shows the current project as selected and the right panel disappears.

**Expected behavior:** Adding a new agent should always happen inside the current project and should only open a new terminal/tab for that project. It should not change project selection, clear current-project UI state, or hide the right panel.

**Fix needed:** Keep the current project context stable during agent creation, and create the new agent terminal/tab under that project without triggering project-switch or panel-hide side effects.

---

### ISSUE-015: Closing the current project should return to root and close the right panel

**Phase:** Project lifecycle polish  
**Severity:** Medium — active project UI can remain inconsistent after closing the current project  
When the current project is closed with the `x` button, Tabtivity should switch back to the root project/session. Because the closed project is no longer active, the right project panel should also close or be hidden.

**Expected behavior:** Closing the active project selects the root project/session, clears the current project selection from the bottom switcher, and hides the right project panel because there is no active project for it to display.

**Fix needed:** Update the project-close path so that closing the active project explicitly activates the root session and tears down project-specific UI state, including the right panel.

---

### ISSUE-016: Closing a project leaves an empty "no project selected" agent tab instead of selecting root

**Phase:** Project lifecycle polish  
**Severity:** Medium — project close lands in an invalid workspace state  
After closing a project, the project panel now closes, but Tabtivity does not switch to the root project/session. The root item in the bottom switcher does not receive the blue active border, and the center panel is left on an empty agent tab that says no project is selected.

**Expected behavior:** Closing the current project should activate the root session, select root in the bottom switcher with the blue border, and show the root agent/terminal rather than an empty no-project placeholder.

**Fix needed:** Ensure the close-project flow activates the root session after clearing project-specific UI, and refreshes both the bottom switcher selection state and center panel tab content.

---

### ISSUE-017: Closing all tabs creates a hidden terminal and breaks the tab bar

**Phase:** Agent/session lifecycle polish  
**Severity:** Medium — empty tab state is broken and confusing  
When all tabs are closed, Tabtivity currently creates a new terminal implicitly. That terminal appears to be hidden, and the tab bar breaks instead of presenting a clear empty state.

**Expected behavior:** If all tabs are closed, do not create an implicit replacement terminal. Show an empty center page explaining that no tab is open and that a new agent or terminal can be created by right-clicking the tab bar.

**Fix needed:** Replace the implicit terminal fallback with an explicit empty-tab state, and keep the tab bar usable for right-click creation actions while no tabs are open.

---

### ISSUE-018: Reddish full-width flicker under high CPU load

**Phase:** Rendering/compositor diagnostics  
**Severity:** Medium — visually disruptive and may indicate a renderer/compositor sync issue  
Under high CPU load, a reddish flicker can appear as a short-height band spanning the full screen width.

**Possible causes:** GSK renderer not synced with vsync; Cinnamon/X11 compositing missing frames; VTE output bursts invalidating large areas; stale themed pixels in overlays.

**Diagnostics needed:** Record `GSK_RENDERER`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, GPU/driver, refresh rate.

**Fix needed:** Harden renderer selection; document a safe override; consider throttling high-frequency UI updates.

---

## Fixed (kept for recurrence reference)

### ~~ISSUE-019: Ollama local-agent tab shows wrong model (mistral-medium-3.5 instead of selected model)~~ ✅ Fixed

**Phase:** Ollama local agents
**Severity:** High — vibe uses the global `~/.vibe/config.toml` instead of the per-model config

**Root cause:** `project.json` `tab_layout` entries for `local_agent` tabs were saved with `"env": {}`. This happened because:

1. The catch block in `handleOllamaModel` (TabBar.tsx) created the tab with an empty env when `ensure_ollama_running` or `prepare_local_agent` threw.
2. Without `VIBE_HOME` set, vibe falls back to `~/.vibe/config.toml` which has `active_model = "mistral-medium-3.5"`.

**How to diagnose if it recurs:**

1. Check `project.json` → `tab_layout` for the affected tab. If `"env": {}` or env is missing `VIBE_HOME`, the env was lost.
2. Check `~/.local/share/tabtivity/vibe_local/<model-alias>/config.toml` — if this file exists and has the correct `active_model`, the fix is to re-populate the tab env.
3. The tab label will be correct (`deepcoder:latest`) but inside the terminal vibe shows the global model.

**Fix applied (src/components/layout/CenterPanel.tsx, src/stores/tabs.ts, src/components/tabs/TabBar.tsx):**

- Added `updateTabEnv` action to tabs store.
- CenterPanel now has an effect that calls `prepare_local_agent` for any `local_agent` tab with an empty env after project load. The tab re-spawns with the correct `VIBE_HOME` and `VIBE_ACTIVE_MODEL`.
- `handleOllamaModel` catch block no longer creates a tab with empty env — if agent prep fails, no tab is created (prevents silently broken tabs).
