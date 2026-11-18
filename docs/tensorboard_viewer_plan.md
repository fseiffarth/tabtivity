# Native TensorBoard viewer — plan

Status: plan only (2026-11-05). No code yet. Never run live.

Tabtivity reads TensorBoard event files (`events.out.tfevents.*`) itself and
draws the training curves in its own viewer tab. No TensorBoard server, no
port, no browser. It works the same for local, SSH and container projects,
because it reads files through the same project-scoped byte read every viewer
uses. It is the companion to `docs/localhost_viewer_plan.md`, which forwards a
real TensorBoard into the system browser. That path keeps everything this
viewer leaves out (profiler, graphs, projector).

## Why

- On Linux there's no safe in-app web engine (`LIVE_SUPPORTED` is false), so
  "TensorBoard inside Tabtivity" can only mean drawing it ourselves.
- Scalars (loss, accuracy, learning rate) are most of what people open
  TensorBoard for. Drawing them needs no server, no Python and no TensorFlow:
  the file format is small and stable.
- A file viewer works without a running process. You can open last week's run,
  a colleague's run copied into the project, or a run on a cluster where you
  can't (or don't want to) start a server on the login node.

## The file format (what we parse)

- **TFRecord framing:** each record is `u64 len (LE)`, `u32 masked
  crc32c(len)`, `len bytes data`, `u32 masked crc32c(data)`. Masked CRC is
  `((crc >> 15) | (crc << 17)) + 0xa282ead8`.
- **`Event` protobuf:** `wall_time` (1, double), `step` (2, int64),
  `file_version` (3, string, first record only), `summary` (5).
- **`Summary.value[]`** (1): `tag` (1), and one of:
  - `simple_value` (2, float). Written by PyTorch `SummaryWriter`,
    tensorboardX and Lightning.
  - `tensor` (8, `TensorProto`) with `metadata.plugin_data.plugin_name ==
    "scalars"`. Written by TF2 `tf.summary.scalar` and Keras. The value is
    `float_val` (5), `double_val` (6) or `tensor_content` (4) by `dtype` (1).
  - `image` (4) / `histo` (5) / other plugins: **counted, not parsed** in
    phase 1. They are listed as "N image / histogram series not shown"
    instead of being skipped silently.

A hand-written protobuf reader (varint, fixed64/32, length-delimited, skip
unknown fields) is about 150 lines. CRC32C is a 256-entry table. **No new
crate**, so no new dependency to vet or keep updated.

## Rules

1. **Event files are attacker-controlled input** (they sit in the project
   folder). The parser is bounded and never panics:
   - A record over 16 MiB is skipped by length.
   - Nested messages go at most 8 deep.
   - At most 200,000 points per tag before downsampling, and 2,000 tags per
     file.
   - Every read is checked against the buffer.
   - A bad CRC stops the scan at that record.
2. **A torn last record is normal.** Training appends while we read. An
   incomplete record at the end isn't an error: the cursor stays before it and
   the next refresh tries again.
3. **Paths go through the existing scoped read.** The command takes
   `(path, projectId)` exactly like `read_file_bytes`, and resolves local
   versus remote through the same routing (`read_file_bytes_any` /
   `remote_read` in `commands/fs.rs`). It never infers remoteness from the
   path.
4. **Hidden panes don't poll.** Live refresh runs only while the pane is
   visible (`PaneVisibleContext`) and catches up on show. Remote reads are
   gated on the host being connected, since a read against a dead session can
   freeze the window.
5. **Read-only.** The viewer never writes, moves or deletes event files.

## Design

### Backend — `src-tauri/src/services/tfevents.rs` (AppHandle-free, pure)

- `scan(bytes, from_offset) -> Scan { next_offset, scalars:
  BTreeMap<tag, Vec<Point{step, wall, value}>>, skipped: SkippedCounts,
  file_version }`.
- `downsample(points, max) -> Vec<Point>`: min/max per bucket, so spikes
  survive (no plain stride), with first and last kept. The default is
  1,500 points per tag.
- Tests:
  - PyTorch-style `simple_value` and TF2-style `tensor` scalars, from small
    fixture files committed as bytes. Generate them once with a script kept in
    `scripts/`, then review the blob id into
    `scripts/privacy-reviewed-binaries.txt`.
  - A torn tail, a bad CRC, an oversized length, garbage input, an empty file,
    and the masked-CRC function against known vectors.

### Backend — `src-tauri/src/commands/tfevents.rs`

- `tfevents_read { path, projectId, cursor? } -> { cursor, scalars,
  skipped, truncated }`. Async over a `*_blocking` body.
  - `cursor` is `{ offset, size, mtime }`. A file that shrank, or changed
    mtime with a smaller size, starts over from 0.
  - Local reads seek to the offset.
  - Remote reads need a new `sftp::read_range_on(sftp, path, offset, max)`.
    `remote_read` today reads whole files, which is too much for a 300 MB
    event file refreshed every 15 s.
- `command_class`: `Core` (the data lives where the daemon runs), so the
  browser client gets it for free. Give it the
  `#[cfg_attr(feature = "desktop", tauri::command)]` attribute and a `Ctx`
  parameter, and regenerate `commandClasses.ts`.
- Merging across refreshes happens in the frontend. Each call returns only new
  points plus the cursor.

### Frontend

- **Detection** in `lib/viewers/fileUtils.ts`: the viewer registry is
  extension-based, but event files are named by **prefix**
  (`events.out.tfevents.<time>.<host>.<pid>…`). Add a name-pattern check
  before the extension lookup, returning `InternalViewer = "tensorboard"`.
  Add a registry row (`viewerType.tensorboard`) so it shows up in the viewer
  list and the opt-out works like the notebook viewer's (#48).
- **Runs = folders.** TensorBoard's model is logdir → runs → tags.
  - Opening one event file shows that run.
  - A folder gets **"Open as training runs"** in the file tree context menu
    (`ProjectFilesView`, the shared viewer, never one host). It lists event
    files at most 3 levels deep and at most 64 files, through the existing
    scoped `list_dir` commands. Each folder that holds event files is a run,
    named by its path relative to the opened folder.
  - Several event files in one run (restarts) are merged by step.
- **`components/embed/TensorBoardView.tsx`**, lazy-loaded inside
  `FileViewerPane`'s `ViewerErrorBoundary` + `<Suspense>` like the other
  heavy viewers.
  - **Tag groups** by the prefix before the first `/` (`train/loss` →
    `train`), as TensorBoard does, and each group can be folded.
  - A tag filter field (substring; regex if the text starts with `/`).
  - **Runs legend**: one color per run, each run can be turned off, and
    colors stay the same across refreshes.
  - **One chart per tag**: hand-rolled SVG like `StatsRecap`'s sparkline (no
    chart library), with x as step, relative time or wall time.
  - **Smoothing slider**: TensorBoard's debiased EMA, 0–0.99, default 0.6. The
    raw line is drawn faint under the smoothed one.
  - Log-scale y toggle, hover readout (run, step, value, smoothed, time),
    click a chart to enlarge it.
  - **Live toggle**, on by default when the newest point is less than 10
    minutes old. It refreshes every 5 s locally and every 20 s remotely.
  - **Footer**: "Not shown: 3 image, 2 histogram series", plus "Open in
    TensorBoard…" when the localhost-viewer plan has landed (it starts
    `tensorboard --logdir <folder>` in a project tab, and that tab's server
    chip does the rest).
- Before writing the chart code, load the `dataviz` skill for colors, marks
  and dark mode. Theme colors come from the CSS tokens.
- All text through `useT()` (`tensorboard.*` keys). `UntestedTag` rows:
  `viewer.tensorboard`, `viewer.tensorboard.runs`, `viewer.tensorboard.live`.

## Phases

1. **Scalars, one file and folder runs.** Rust parser + command +
   `read_range_on`, detection, viewer, live refresh. Local + SSH. A
   container project's files are on the host (same absolute path), so they
   work without extra code.
2. **Images and text.** `Summary.Image.encoded_image_string` and the TF2
   `images` plugin (PNG in `string_val`) as a step slider per tag, shown with
   the image viewer's `<img>` from a `blob:` URL (CSP already allows `blob:`
   images). The `text` plugin is shown as Markdown through the existing
   renderer.
3. **Hparams table.** The `hparams` plugin's session data as a table of runs ×
   hyperparameters × final metrics, reusing the table viewer's grid.
4. **Histograms** as ridgeline or offset charts, only if asked for.
   **Never:** profiler, graph, projector, mesh. Those stay with the real
   TensorBoard through the localhost viewer.
5. **Phone** (optional): read-only charts in the phone's file viewer, through
   the same command over the mobile file token route. Raw paths never cross
   the phone API.

## Gates and tests

`cargo test --workspace` (parser + command scan tests), `npm test`
(`fileUtils` detection, EMA smoothing, the run-grouping and merge logic as
pure functions in `lib/viewers/tensorboard.ts`), `npm run build`, lint,
clippy, and the daemon build (`--no-default-features`), because the command
is `Core`.

## Manual QA (todo 2428, 🖐️ with per-platform ✅/❌ pairs)

1. Train a tiny PyTorch model with `SummaryWriter` in a local project. Open
   the event file: the loss curve shows, smoothing changes it, and hover
   reads values.
2. Keep training running. With Live on, new points appear within about 5 s.
   Hide the pane and show it again: it catches up.
3. A TF2/Keras run (`tf.keras.callbacks.TensorBoard`): its scalars show
   (tensor-encoded path).
4. "Open as training runs" on a folder with three runs: three colored lines
   per tag, and each run can be turned off.
5. A remote project: the same steps on an event file on the host. Disconnect,
   and the viewer stops polling and says so.
6. A 300 MB event file with images: it opens without freezing, and the
   footer counts the images it doesn't show.
