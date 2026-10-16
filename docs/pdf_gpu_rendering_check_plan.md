# PDF GPU-rendering check — plan for an unfenced session

Written 2026-10-14 by a fenced session that could not see the host. Execute it
from a session **outside** the agent fence (normal terminal, project root).
Self-contained: the fenced session's memory notes are not visible from there.

## Question

Why do PDFs scroll slowly in Tabtivity on Linux, and can WebKitGTK's GPU path
(DMA-BUF renderer) be turned on to fix it? `src-tauri/src/lib.rs` (`run()`)
forces `WEBKIT_DISABLE_DMABUF_RENDERER=1` on every Linux machine, so pages
paint and composite on the CPU. macOS (WKWebView) and Windows (WebView2) composite
on the GPU.

## Already established (user-observed, 2026-10-14)

Host: Ubuntu 26.04, kernel 7.0.0-38, GNOME on Wayland, device scale 2,
Radeon 890M (radeonsi, strix1). System WebKitGTK 2.52.6, Mesa 26.0.8.
Test file: one large PDF with many figures (the user has it; ask for the path).

| # | Setup | Figures |
|---|---|---|
| 1 | Tabtivity (2.52.6, DMA-BUF off, pdfjs-dist 6.4.299) | aligned |
| 2 | Native PDF viewer | aligned |
| 3 | Firefox (Gecko pdf.js) | aligned |
| 4 | MiniBrowser 2.52.6, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, hosted pdf.js | aligned |
| 5 | MiniBrowser 2.52.6, `WEBKIT_DISABLE_DMABUF_RENDERER=0`, hosted pdf.js | **misaligned** |
| 6 | GNOME Web Flatpak (2.54.1, GTK4, Mesa 26.2.2), DMA-BUF on, built-in viewer | **misaligned** |
| 7 | as 6 + `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` | **misaligned** |
| 8 | as 6 + `AMD_DEBUG=nodcc` | misaligned (a bit better) |
| 9 | as 6 + `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe) | **misaligned** |
| 10 | as 6, hosted pdf.js (mozilla.github.io) | **misaligned** |

Working conclusion: WebKitGTK's GPU/DMA-BUF compositing path misplaces PDF
figures on **any** driver (radeonsi and llvmpipe), in 2.52 and 2.54. Not a Mesa or
AMD bug, not a pdf.js bug. Earlier (2026-08-05, WebKitGTK 2.52.3) the same
path also flickered, dropped images and crashed the renderer on this machine.
Hypothesis (untested): large canvases at device scale 2, tiled by the GL
compositor.

## Rules for the executing session

- **Never start, stop or restart Tabtivity** (AGENTS.md). Check G is the
  user's to run.
- You cannot see the screen and GNOME/Wayland blocks scripted screenshots.
  You launch, the user looks. Ask one check at a time with `AskUserQuestion`:
  aligned / misaligned / other symptom (flicker, missing images, crash), and
  scroll speed vs Tabtivity.
- Launch each browser in the background, one at a time. Kill only the PID you
  started, after the user answers. No `pgrep -f` wait loops.
- Strip inherited Tabtivity settings from every launch: prefix with
  `env -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE`
  before setting the variables a check needs.
- Install nothing system-wide (no PPAs, no apt) without asking. GNOME Web
  (`org.gnome.Epiphany`) is already installed as a Flatpak.
- File no bug report yourself; draft it (step 5) for the user to file.
- Same PDF, same pages, same zoom for every check. Record the page numbers that
  misalign in check A and reuse them.

Shorthands below:

```
MB=/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser
VIEWER=https://mozilla.github.io/pdf.js/web/viewer.html   # open the PDF via its open-file icon (top right) or drag-and-drop
CLEAN='env -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE'
```

## Steps

### 1. Inventory (no user input)

Record in **Results**:

- `dpkg-query -W libwebkit2gtk-4.1-0 libwebkitgtk-6.0-4 mesa-libgallium libgl1-mesa-dri linux-firmware`
- `uname -r`, `echo $XDG_SESSION_TYPE`
- `flatpak info org.gnome.Epiphany | grep -E 'Version|Runtime'`
- `flatpak list --runtime | grep -E 'GL.default|org.gnome.Platform'`
- `journalctl -k -b --no-pager | grep -iE 'amdgpu.*(error|fault|timeout|reset)' | tail -20`
- `journalctl --user -b --no-pager | grep -iE 'WebKit|WEBVIEW .* TERMINATED|SIGBUS' | tail -20`

Ask the user for the test PDF path and the pages that misalign.

### 2. Confirm the key pair (system 2.52.6)

- **A** `$CLEAN WEBKIT_DISABLE_DMABUF_RENDERER=1 $MB $VIEWER`: expected aligned (repeats #4)
- **B** `$CLEAN WEBKIT_DISABLE_DMABUF_RENDERER=0 $MB $VIEWER`: expected misaligned (repeats #5)

If A or B don't match the expectation, stop and report. The working conclusion
is then wrong.

### 3. Isolate inside the GPU path (system 2.52.6, DMA-BUF on)

Each is check B plus one variable:

- **C** `LIBGL_ALWAYS_SOFTWARE=1`: misaligned = WebKit, not radeonsi (repeats #9 on 2.52)
- **D** `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`: CPU paint, GPU composite
- **E** `WEBKIT_DISABLE_COMPOSITING_MODE=1`: no accelerated layer compositing. Aligned here = the layer compositor is at fault
- **F** zoom test in B: same page at 50 %, 100 %, 200 %, 400 %. If it misaligns only above some zoom, canvas size is the trigger. Note the threshold.

### 4. 2.54 with the GPU path off (matters for Tabtivity's future)

Ubuntu will ship 2.54. Tabtivity keeps DMA-BUF off, and reports say that path
glitches or paints partly on 2.54.

- **H** `flatpak run --env=WEBKIT_DISABLE_DMABUF_RENDERER=1 org.gnome.Epiphany`.
  Check `webkit://gpu` (renderer should not be DMABuf), then the PDF (built-in
  viewer and `$VIEWER`). Ask: aligned? any glitch or partial paint anywhere
  (menus, page fades, window resize)?

### 5. Tabtivity itself (user runs it, optional)

- **G** The user quits Tabtivity, starts it from a plain terminal with
  `WEBKIT_DISABLE_DMABUF_RENDERER=0`, opens the PDF in Tabtivity's viewer and
  scrolls 10+ min. Tabtivity caps raster size (`pdfRasterRatio`,
  `src/components/embed/pdf/PdfViewer.tsx`), so it may avoid a canvas-size
  trigger. Ask: aligned? flicker, missing images, crash? faster? Then the user
  restarts Tabtivity normally.

### 6. Write up

1. Fill **Results** below.
2. Draft a WebKit bug in **Bug report draft**: title, versions, the matrix
   (#3–#10 plus C–F, H), steps with `$VIEWER`, expected vs actual. Leave a
   placeholder for the PDF/page attachment. The user decides what can be shared.
3. Verdict, one of:
   - **GPU path unusable** (F has no safe threshold, G misaligns): keep the
     disable; next work is CPU-path speed in `PdfViewer.tsx` (lower raster
     while scrolling, sharpen when idle; smaller and fewer canvases).
   - **Canvas-size workaround** (F shows a threshold and G is clean): propose
     capping canvas size and an opt-in "GPU compositing (experimental)"
     setting (`useExperimental`, `schema/settings.rs`). Do not build it unasked.
   - **2.54 risk** (H glitches): add a 🖐️ item in the matching `todo/*.md`
     ("check PDFs + window paint once Ubuntu ships WebKitGTK 2.54"), with the
     platform ✅/❌ child pair for `Linux (Wayland)` and `Linux (X11)`.
4. Change no code. Report to the user and stop.

## Results

Executed 2026-10-14 by an unfenced session. Tabtivity was not started or
stopped. Check G was not run.

### Method (differs from the plan, on purpose)

The plan assumed the user would judge every check by eye. Instead each check
was **measured**: a probe WebView (`python3-gi`, `Gtk.Window` + `WebKit2.WebView`,
one process per check, run one at a time) loaded a minimal pdf.js page:
pdfjs-dist 6.4.299 from `node_modules`, served from `127.0.0.1`, the PDF passed
as `data` like `lib/viewers/pdfLoad.ts`, one `<canvas>` per page at
`devicePixelRatio` 2. Its output was then pixel-diffed (ImageMagick
`compare -metric AE -fuzz 12%`) against the same page with DMA-BUF off.

- **Pixels**: on Xwayland (`GDK_BACKEND=x11`, GNOME's native Xwayland scaling,
  device scale 2) `import -window <xid>` grabbed the composited window. The
  XID came from the probe's own `GdkX11` window and was checked against
  `_NET_WM_PID` + a unique `WM_NAME` before every grab. On native Wayland
  `webkit_web_view_get_snapshot` was used instead. On Xwayland the snapshot and
  the window grab showed the same defect, so snapshots are valid evidence here.
  The user confirmed by eye that the baseline capture (A0) looks right.
- **Facts per run**: the probe then loaded `webkit://gpu` and recorded the
  version, Renderer, Platform, Policy and env.
- **Speed**: the page timed `getDocument` + `render()`, then scrolled the
  document by script (`scrollTo` +40/60 px per `requestAnimationFrame`) and
  recorded the frame intervals (median, p95, frames > 25 ms).
- **2.54** (step 4): the same probe ran inside the GNOME Web Flatpak sandbox
  (`flatpak run --command=python3 org.gnome.Epiphany`), whose runtime
  (`org.gnome.Platform//51`) also ships the GTK3 `WebKit2 4.1` API at 2.54.1.
- Test file: the user's one-page `~/Downloads/Testpage.pdf` (A4, LaTeX →
  Ghostscript; a 4624×3472 JPEG plus two 1920×1080 JPEGs and dense vector
  plots, "Figure 4.4").

### Inventory

| | |
|---|---|
| WebKitGTK (system) | `libwebkit2gtk-4.1-0` / `libwebkitgtk-6.0-4` 2.52.6 (Ubuntu 26.04 package) |
| Mesa | `mesa-libgallium`, `libgl1-mesa-dri` 26.0.8-1ubuntu0.3 |
| linux-firmware | 20260319.git217ca6e4.1ubuntu |
| Kernel / session | 7.0.0-38-generic, wayland (mutter `scale-monitor-framebuffer`, `xwayland-native-scaling`) |
| GNOME Web Flatpak | 51.1, runtime `org.gnome.Platform/x86_64/51` → WebKitGTK 2.54.1 |
| Flatpak GL runtimes | Mesa 26.2.4 (25.08), Mesa 26.2.2 (26.08) |
| GPU facts (`webkit://gpu`, on) | Renderer DMABuf (Hardware, SHM); Platform GBM; amdgpu DRM 3.64; 2D canvas Accelerated; MSAA 8 |
| Kernel log | no amdgpu error/fault/timeout/reset this boot |
| User journal | no WebKit crash / `TERMINATED` / SIGBUS lines this boot |

### Headline

**The fault is WebKit's GPU-accelerated 2D canvas, not the layer
compositor.** With DMA-BUF on, pdf.js's drawing into a `<canvas>` silently
loses whole draw operations (text runs, entire vector plots, axis labels, the
caption). Which ones are lost changes from run to run. Turning off only the
accelerated canvas, while keeping the DMA-BUF renderer and GPU compositing,
gives output pixel-identical to the CPU path **and** keeps 60 fps scrolling.

In these probes the symptom was always *missing* content, never displaced
figures. The user's earlier "misaligned" (#5–#10, via the full pdf.js viewer,
which also paints images through extra canvases) is very likely the same
canvas defect. This was not checked by eye with the full viewer (see "Open").

### Correctness matrix (differing px vs DMA-BUF-off baseline; 0 = identical)

Content diffs exclude the scrollbar strip. E/X1/X2 on Xwayland differ from A0
only in a 10 px column at x=1786 (the scrollbar), 6 940 px.

| Check | Setup (DMA-BUF on unless said) | 2.52.6 Xwayland | 2.52.6 Wayland | 2.54.1 Wayland |
|---|---|---|---|---|
| A | DMA-BUF **off** | 0 (A1 vs A0) | 0, 0, 0 | 0, 0 |
| B | DMA-BUF on | **235k, 226k** — broken | **83k, 134k, 190k, 102k, 739** — broken | **30k, 82k** — broken |
| C | + `LIBGL_ALWAYS_SOFTWARE=1` (Surfaceless/SHM) | **231k** — broken | | |
| D | + `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` | **216k** — broken | | |
| E | + `WEBKIT_DISABLE_COMPOSITING_MODE=1` | scrollbar only — OK (Policy falls to "never", i.e. same as off) | 0, 0 | |
| X1 | + feature `CanvasUsesAcceleratedDrawing` **off** | scrollbar only — OK | 0 ×5 | 0, 0 |
| X2 | + `getContext('2d', { willReadFrequently: true })` (page-side) | scrollbar only — OK | 0 ×5 | 0, 0 |
| X3 | + `WEBKIT_SKIA_MSAA_SAMPLE_COUNT=0` | **227k** — broken | | |
| X4 | + `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` | **238k** — broken | | |
| X5 | + `WEBKIT_SKIA_GPU_PAINTING_THREADS=0` | **233k** — broken | | |
| X6 | + feature `AcceleratedDrawing` off (tiles on CPU) | **223k** — broken | | |

C and D add the finding that llvmpipe and Skia's CPU raster for *tiles* don't
help. The canvas stays GPU-backed in both, so it is not radeonsi and not the
compositor. X6 is the converse check: CPU tiles + GPU canvas is still broken.

**F, zoom / canvas size** (Wayland, 2.52.6, two runs per zoom, canvas in device px):

| zoom | canvas | DMA-BUF on |
|---|---|---|
| 0.25 | 396×561 | broken (9k, 12k): whole "E left" plot, "D back" plot, caption gone |
| 0.5 | 793×1122 | broken (15k, 22k) |
| 0.75 | 1190×1683 | broken (55k, 34k) |
| 1 | 1587×2245 | broken (see B) |
| 2 | 3174×4490 | broken (32k, 23k) |
| 3 | 4762×6735 (32 MP) | OK (377 px, both runs; no visible loss) |

No small-canvas safe zone: even a 396×561 canvas loses content. Only a very
large canvas is clean, consistent with WebKit falling back to an unaccelerated
canvas above its size limit. The hypothesis "large canvases at scale 2" is
therefore **wrong**; size cannot be the workaround.

### Speed (Wayland, scripted scroll, frame interval in ms)

900×1000 window, 4 pages at 100 %, 2.52.6: off 25/17 median (39/1 frames
> 25 ms); on, X1, X2 all 17 median, 0–3 frames > 25 ms.

Near-fullscreen 1800×1050 window, 6 pages at 150 %, 152 frames per run:

| Setup | 2.52.6 median / p95 / frames > 25 ms | 2.54.1 median / p95 / frames > 25 ms |
|---|---|---|
| DMA-BUF off (Tabtivity today) | 41/55/152 · 54/128/152 · 42/56/152 | **131/245/152 · 63/85/152** |
| DMA-BUF on (broken) | 17/17/0 · 17/24/2 · 17/20/2 | 17/20/0 · 17/22/4 |
| on + canvas accel off (X1) | 17/24/5 · 22/53/50 · 18/31/11 | 17/25/5 · 17/24/3 |
| on + willReadFrequently (X2) | 17/19/0 · 17/24/6 · 18/32/16 | 17/21/1 · 20/34/43 |

- Today's CPU path manages ~20–24 fps at near-fullscreen on 2.52, and on 2.54
  it is 2–3× worse (8–16 fps).
- The GPU compositor with a CPU canvas (X1/X2) holds ~60 fps on both versions.
  The slow scrolling is the CPU *compositing*, not the canvas raster.
- On Xwayland all configs scroll alike (38–54 ms): there the UI process maps
  each DMA-BUF through the CPU ("Buffer format … [Mapping]"), so X11 numbers
  say nothing about speed.
- Render time (`page.render`, first page incl. the 4624×3472 JPEG decode) is
  1.1–1.5 s on Wayland in every config. Repeat renders take ~0.1–0.4 s CPU and
  ~0.2–0.9 s GPU canvas. Load (`getDocument` + `getPage`) takes 0.12–0.3 s
  everywhere. Neither is the bottleneck.

### H — 2.54 with the GPU path off

Content is pixel-identical to 2.52.6 off (0 px, `H_base` vs `W_base`), with no
partial paint in the page. Not checked: menus, page fades, window resize. The
UI-side paint isn't visible to a web-process snapshot, so those need eyes. The
measurable 2.54 risk is speed: the CPU path regresses badly (table above).

### Not run / open

- **G** (Tabtivity with DMA-BUF on) not run: it's the user's, and as the plan
  states it would only re-show B. Tabtivity's PDF canvases use plain
  `getContext("2d")` (`PdfViewer.tsx:983`, `:1027`, `pdfDoc.ts:336`, …), so
  they would hit the defect.
- The full pdf.js viewer was not re-checked by eye with the canvas switch.
  One-window confirmation for the user:
  `env -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE WEBKIT_DISABLE_DMABUF_RENDERER=0 /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser --features=-CanvasUsesAcceleratedDrawing https://mozilla.github.io/pdf.js/web/viewer.html`.
  Expected: aligned, all content present, fast scroll.
- The 2026-08 flicker and renderer crash under stress were not re-tested. Each
  probe ran ~10 s, with no crash in ~70 runs.
- Probe harness (scratchpad, not in the repo): `drive.py`, `run.sh`, `frun.sh`
  and `test.html` with `?zoom=&pages=&scroll=&step=&wrf=`.

### Verdict

**Built behind a flag** (2026-10-14, `docs/gpu_compositing_plan.md`): an
experimental Linux "GPU compositing" switch, canvas acceleration off on every
webview. Live-unverified.

None of the plan's three verdicts fits. **New verdict: the GPU path is usable
with the accelerated 2D canvas off.** F shows no size threshold, so
"canvas-size workaround" is out. "GPU path unusable" is also wrong: X1 and X2
are correct and fast on 2.52.6 and 2.54.1. The "2.54 risk" is not a glitch
(H is clean in the page). It is that keeping DMA-BUF off gets 2–3× slower on
2.54.

Candidate change (not built, per step 6.4; the user decides):

1. Linux: stop forcing `WEBKIT_DISABLE_DMABUF_RENDERER=1`
   (`src-tauri/src/lib.rs:1267`). Instead turn off the WebKit feature
   `CanvasUsesAcceleratedDrawing` on every webview's `WebKitSettings`
   (`webkit_settings_set_feature_enabled`, through Tauri's `with_webview`). This
   is global, so it covers every canvas in the app, not only PDF.
2. Alternative or backstop, frontend-only: `willReadFrequently: true` on the
   PDF canvases. It only protects canvases that remember to ask.
3. Gate it behind an opt-in at first (`useExperimental` / `schema/settings.rs`)
   with the current disable as the default. Then a G-style live soak (10+ min,
   PDFs, terminals, markup, deck presenter) before flipping the default. The
   2026-08 crash/flicker must be re-checked under X1, because those were seen
   with the accelerated canvas still on.

## Bug report draft

**Title:** [GTK][Skia] Accelerated 2D canvas silently drops draw operations
(pdf.js text and vector paths missing) with the DMA-BUF renderer on AMD radeonsi
and llvmpipe

**Component:** WebKitGTK → Canvas / Skia

**Versions:** WebKitGTK 2.52.6 (Ubuntu 26.04 `libwebkit2gtk-4.1-0`
2.52.6 (Ubuntu 26.04 package), Mesa 26.0.8) and 2.54.1 (GNOME 51 Flatpak runtime,
Mesa 26.2.x). Kernel 7.0.0, GNOME Wayland, device scale 2. Also reproduces
under Xwayland. GPU: AMD Radeon 890M (radeonsi, gfx1150 "strix1"), amdgpu DRM
3.64. Also with `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe).

**Steps:**
1. Run with the default DMA-BUF renderer (`webkit://gpu`: Renderer DMABuf,
   2D canvas Accelerated).
2. Render a PDF page with pdf.js (4.x–6.x; tested 6.4.299) into a `<canvas>`
   via `page.render({ canvasContext: canvas.getContext('2d'), … })`. Or open
   it in `https://mozilla.github.io/pdf.js/web/viewer.html`.
   _[attach: PDF page / reduced test case — user decides what can be shared]_
3. Compare against the same render with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Expected:** identical output.

**Actual:** whole draw operations are missing: text runs, entire vector plots,
axis labels, a figure caption. The set that is lost varies between runs. 2–7 %
of the window's pixels differ.
Every one of 18 runs at canvas sizes from 396×561 to 3174×4490 device px
differed (one only by 739 px). A 4762×6735 canvas renders correctly (presumably the
unaccelerated fallback). On the full pdf.js viewer the visible symptom has also
been described as misplaced figures.

**Isolation:**

| Variable (DMA-BUF on) | Result |
|---|---|
| `LIBGL_ALWAYS_SOFTWARE=1` | still broken (not driver-specific) |
| `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` | still broken |
| feature `AcceleratedDrawing` off | still broken |
| `WEBKIT_SKIA_MSAA_SAMPLE_COUNT=0` | still broken |
| `WEBKIT_SKIA_GPU_PAINTING_THREADS=0` | still broken |
| `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` | still broken |
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | correct |
| feature `CanvasUsesAcceleratedDrawing` off | **correct** |
| `getContext('2d', { willReadFrequently: true })` | **correct** |

Firefox (Gecko pdf.js) and poppler render the same file correctly.

**Workaround:** disable `CanvasUsesAcceleratedDrawing`, or request
`willReadFrequently` contexts.
