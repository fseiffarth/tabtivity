# GPU compositing (Linux, experimental) — implementation plan

Written 2026-10-14. Status: built 2026-10-14 (steps 1–10), uncommitted and
**live-unverified**; TODO `todo/group-u-performance.md` #2421 / #2422.

## Goal

An opt-in **Settings → Experimental → "GPU compositing"** switch, Linux only.

- **On**: Tabtivity stops forcing `WEBKIT_DISABLE_DMABUF_RENDERER=1`, so
  WebKitGTK composites on the GPU.
- **Always on Linux**: 2D-canvas acceleration is off on every webview. This
  avoids the canvas defect that made the GPU path unusable.
- **Off (the default)**: behaviour is today's.

## Evidence

`docs/pdf_gpu_rendering_check_plan.md` → Results / Verdict, measured on
2.52.6 and 2.54.1 (Radeon 890M, Wayland, scale 2):

- **The defect.** With DMA-BUF on, WebKit's accelerated 2D canvas silently
  drops draw operations: pdf.js text, whole plots, the caption. It happens on
  radeonsi and llvmpipe, at every canvas size ≤ 3174×4490.
- **The fix.** DMA-BUF on with canvas acceleration off renders pixel-identical
  to the CPU path and scrolls at ~60 fps. Today's CPU path manages ~20 fps on
  2.52 and 8–16 fps on 2.54 at near-fullscreen.
- **The defect is content-dependent** (user report): many PDFs never show it.
  A clean PDF proves nothing, so live checks must use one that triggers it
  (`~/Downloads/Testpage.pdf`).
- **The property works on a live page.** Probe 2026-10-14: setting
  `enable-2d-canvas-acceleration=false` on a webview *after* its page had
  loaded fixed canvases created afterwards (3/3 runs pixel-identical). The
  control run without it was broken. On 2.52.6, setting the property also
  flips the `CanvasUsesAcceleratedDrawing` feature to false.

## Design decisions

1. **Switch: the GObject property `enable-2d-canvas-acceleration`.** Not the
   feature-list API.
   - It is public API since 2.46, and it drives the same preference
     (verified above).
   - `webkit2gtk` 2.0.2 (`Cargo.toml:352`, features up to `v2_40`) has no
     binding for it.
   - Don't confuse it with the crate's `enable_accelerated_2d_canvas`
     (`auto/settings.rs:198`): that is the old, deprecated
     `enable-accelerated-2d-canvas` property.
   - So: `glib::ObjectExt::set_property` on the view's `WebKitSettings`, behind
     `find_property("enable-2d-canvas-acceleration").is_some()`. glib-rs panics
     on an unknown property, and WebKitGTK < 2.46 lacks it.
   - No FFI, no `dlsym`, no new dependency (`gtk::glib` is already in tree,
     `Cargo.toml:357`).
2. **Hook: one Tauri plugin with `on_webview_ready`.** It is called for every
   webview, present and future, so nothing per-window is needed (the API is in
   tauri ≥ 2.11, `plugin.rs:530`; the lockfile has 2.12.3).
   - Today's per-window hooks miss windows. `hook_webview_crash_reporter` runs
     for config windows (`lib.rs:665`), connect (`commands/connect.rs:164`),
     the browser live page (`commands/browser.rs:397`) and print
     (`commands/print_native.rs:210`). It does **not** run for the detached
     popout (`commands/subwindow.rs:337`) or the presenter
     (`commands/presenter.rs:148`). The plugin covers those too.
   - Register it next to `.plugin(nav_gate_plugin())` (`lib.rs:2463`).
3. **Canvas acceleration off on Linux always**, not only when the switch is
   on. Recommended because:
   - With DMA-BUF off, it changed nothing measurable: W_off and W_x1 both
     differ by 0 px from the baseline, at the same speed.
   - It also protects a user who exports `WEBKIT_DISABLE_DMABUF_RENDERER=0`
     themselves (step G of the check plan). That is otherwise a silent-artifact
     path.
   - One code path, no restart coupling.
   - The only cost: "today's behaviour exactly" becomes "today's pixels, one
     inert setting more".
4. **Precedence is unchanged: the environment wins.** `lib.rs:1267` already
   sets the variable only when `var_os(...).is_none()`. The new rule:
   - The variable is set to `1` only if it is unset **and** the switch is off.
   - An explicit `WEBKIT_DISABLE_DMABUF_RENDERER=1` stays the escape hatch if a
     GPU launch is unusable.
5. **Read the setting synchronously at the top of `run()`** with
   `storage::load_settings()` (`storage.rs:444`, a plain `read_json` of
   `settings.json`).
   - Same pattern as `restore_main_window` (`lib.rs:1069`).
   - `state_dir()` resolves a not-yet-migrated legacy folder by itself
     (`storage.rs:412`), so reading before `brand_migration::run_at_launch()`
     is safe.
   - It must stay before `services::webkit_video::install()` (`lib.rs:1276`),
     which reads the decided variable. The video module already handles "on":
     `should_install` → false, GPU decoders keep their rank
     (`webkit_video.rs:97`).
   - It must also stay before any thread spawn, because of `set_var`.
   - Missing or corrupt file → switch off.
6. **Flag semantics: strict default-off in Debug mode too.**
   - Backend: `gpu_compositing()` = `unwrap_or(false)`, like
     `browser_live_pages()` (`schema/settings.rs:1206`), not `experimental()`.
   - Frontend: add to `EXPERIMENTAL_FLAGS` with the same exemption
     `terminal_webgl` has (`src/lib/experimental.ts:85`, `:94`). Debug mode
     never carries it, and the migration leaves it unset.
   - Why: it changes the renderer and has crash history.
7. **Takes effect at the next launch.** The help text says so. No live toggle
   (the variable is read once, at GTK/WebKit init). No new Tauri command: the
   flag round-trips through the existing `save_settings`/`patch_settings`, so
   no `command_class` row is needed.
8. **WebGL is not covered.** The property is for 2D canvas only. App WebGL
   users:
   - xterm's WebGL renderer, behind its own experimental `terminal_webgl`
     (`schema/settings.rs:617`, `TerminalView.tsx:402`, demotes itself on
     failure);
   - pdf.js and mermaid use 2D canvas/SVG;
   - `ProjectBlobPane.tsx:137` explicitly renders without WebGL.

   Both flags on together is an untested combination; the help text says to
   test the GPU switch alone first.

## Steps

1. **Pure decision fn.** New `src-tauri/src/services/webkit_gpu.rs`
   (`pub mod webkit_gpu;` beside `webkit_video`, `services/mod.rs:237`),
   cross-OS:
   - `pub const CANVAS_ACCEL_PROPERTY: &str = "enable-2d-canvas-acceleration";`
   - `pub fn should_disable_dmabuf(inherited: Option<&OsStr>, gpu_compositing: bool) -> bool { inherited.is_none() && !gpu_compositing }`
   - Reuse `webkit_video::DMABUF_RENDERER_VAR` for the name.
2. **Startup.** `lib.rs:1262–1269`, Linux block:
   - `let gpu = storage::load_settings().is_some_and(|s| s.gpu_compositing());`
   - then `if webkit_gpu::should_disable_dmabuf(env::var_os(VAR).as_deref(), gpu) { set_var(VAR, "1") }`
   - Rewrite the comment: the SIGBUS history plus the canvas finding, linking
     both plans.
3. **Canvas switch.** In `lib.rs`, `#[cfg(feature = "desktop")]`, a
   `webkit_tuning_plugin<R>()`:
   - `tauri::plugin::Builder::new("webkit-tuning").on_webview_ready(|wv| { #[cfg(target_os = "linux")] disable_canvas_accel(&wv); }).build()`
   - Linux `disable_canvas_accel`:
     `wv.with_webview(|p| { if let Some(s) = WebViewExt::settings(&p.inner()) { if s.find_property(CANVAS_ACCEL_PROPERTY).is_some() { s.set_property(CANVAS_ACCEL_PROPERTY, false) } } })`
   - Log once to stderr when the property is absent (WebKitGTK < 2.46).
   - Every `use tauri::…`/`webkit2gtk` import stays inside `cfg(feature = "desktop")` + `cfg(target_os = "linux")`.
   - Register: `.plugin(webkit_tuning_plugin())` before the nav gate.
4. **Settings schema.** `schema/settings.rs`:
   - Field `pub gpu_compositing: Option<bool>`, placed after `terminal_webgl`
     (line 617), with `serde(default, skip_serializing_if…)`. The doc comment
     says: EXPERIMENTAL, default OFF, Linux only, read at launch by `run()`.
   - Accessor `gpu_compositing()` (strict `unwrap_or(false)`) beside
     `browser_live_pages()`.
5. **Frontend flag.** `src/types/index.ts:647` (add
   `gpu_compositing?: boolean`). In `src/lib/experimental.ts`:
   - add to `EXPERIMENTAL_FLAGS`;
   - extend the `terminal_webgl` null-guard and the `DEBUG_CARRIED_FLAGS`
     filter to it;
   - add a header-comment line.
6. **Settings UI.** `SettingsPanel.tsx`: a `ToggleCard` after the
   `terminalWebgl` card (`:2107`), rendered only when `IS_LINUX`
   (`src/lib/platform.ts:27`).
   - Label: `t("settings.gpuCompositing")` +
     `<UntestedTag id="settings.gpuCompositing" />`.
   - `checked={experimentalEnabled(settings, "gpu_compositing")}`, plus the
     help key.
   - Add the label key to the `experimental` list in `SEARCH_KEYS` (`:1195`).
   - Copy the existing card exactly (shared `settingsUi.tsx`, no new styling).
7. **i18n.** `src/lib/i18n.ts` (next to `:1466`), translated in
   `i18nDicts/{de,es,fr,it}.ts`:
   - `settings.gpuCompositing` = "GPU compositing".
   - `settings.gpuCompositingHelp` = "Lets the window paint on the GPU, which
     makes scrolling much smoother. Applies after you restart {app}. Turn it
     off if you see flicker, missing content or crashes. Starting with
     WEBKIT_DISABLE_DMABUF_RENDERER=1 forces it off."
8. **Untested register.** `src/lib/untested.ts` (near `:313`), row
   `"settings.gpuCompositing": { area: "layout", what: "SettingsPanel · GPU compositing (DMA-BUF on, canvas acceleration off)" }`.
9. **Docs.**
   - File-map rows: `docs/filemap_backend.md` (new `webkit_gpu.rs`, one line;
     touch the `webkit_video.rs` row only if wording needs it).
   - Status line at the top of this plan.
   - The check plan's Verdict → "built behind a flag".
10. **TODO.** In `todo/group-u-performance.md`, a 🖐️ item (text below) with
    ✅/❌ pairs for `Linux (X11)`, `Linux (Wayland)`, `Windows`, `macOS`. On
    Windows/macOS the check is "setting not shown, nothing changes". Plus a
    second 🖐️ item: "re-check PDFs (Testpage.pdf) + window paint and
    speed, switch off and on, once Ubuntu ships WebKitGTK 2.54".

## Tests & gates

- `webkit_gpu::tests`:
  - unset env + off → set;
  - unset env + on → don't set;
  - `"1"` / `"0"` / `""` inherited → never touched, either switch value;
  - plus a test that the constant matches the probe-verified name.
- `schema/settings.rs` tests: `gpu_compositing_defaults_absent_and_round_trips`
  (pattern: `:1354`). Also `gpu_compositing()` is false when unset even with
  `debug: true` and no `experimental_explicit`.
- Frontend: extend the experimental-flag tests: `gpu_compositing` unset →
  off in Debug mode; the migration doesn't write it; an explicit true wins.
- Gates (`scripts/gates.sh`):
  - the Rust set + `--no-default-features` daemon lib build/clippy;
  - `npm run build`, `npm test`, `npm run lint`;
  - `scripts/brand-check.sh`.
  - `cfg`-gated code → the Windows msvc clippy/check and the
    `aarch64-apple-darwin` `cargo check` from AGENTS.md before push.
- Optional: re-run the check plan's probe with the property set
  post-load on 2.54.1 (Flatpak) to confirm decision 1 there.

## Live checklist (the user; agents never launch the app)

TODO text: "🖐️ Manual test: tick Settings → Experimental → GPU compositing,
restart. Then:"

1. A webview's `webkit://gpu` (or `ps e` on the WebKitWebProcess) shows
   Renderer DMABuf / no `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
2. Open `Testpage.pdf`: every plot, label and the caption are present, and
   figures aligned. Repeat at 50/100/200 % zoom and after scrolling away and
   back.
3. Scroll a long, figure-heavy PDF for 10+ minutes. Note: smoother than with
   the switch off? Any flicker, missing tiles, or a
   `WEBVIEW … TERMINATED` line in crash.log?
4. Terminals (typing, fast output), markup layer drawing, deck presenter
   (fullscreen), a detached popout, print preview, a browser live page,
   window resize/maximize, menus and dialogs: no partial paint.
5. Untick, restart: back to today's path (`webkit://gpu`: no DMABuf).

## Risks / open questions

- **The 2026-08 renderer crash and flicker** were seen with the canvas still
  accelerated. Whether they persist with it off is unknown. That is why the
  switch is opt-in, and why step 3 of the live checklist is a soak.
- **Other GPUs and drivers**: only one machine is measured. The defect
  reproduced on llvmpipe too, so the canvas switch matters everywhere. The
  compositor's own stability elsewhere is unknown.
- **X11 sessions** get no speed gain: the UI process maps every frame through
  the CPU, measured under Xwayland. Correctness is the same.
- **A crash loop at launch** with the switch on is escaped with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` or by editing `settings.json`. Consider
  a later auto-revert after N renderer crashes (out of scope).
- **Spawned children**: `WEBKIT_DISABLE_DMABUF_RENDERER=1` is inherited by
  terminals and launched apps today (webkit_video strips only its own variable,
  `webkit_video.rs:29`). Pre-existing, unchanged by this plan, but worth a
  separate TODO.
- **Content-dependence**: a clean run on an arbitrary PDF is not evidence.
  Always include a triggering file.
