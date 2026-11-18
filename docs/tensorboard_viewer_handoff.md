# Native TensorBoard viewer: phase 1 handoff

Branch `tb-viewer` (from `develop` at ee3685eb), built in a worktree. **Never run
live in the app.** Plan: `docs/tensorboard_viewer_plan.md` (phase 1 only:
scalars, one file and folder runs, live refresh, local + SSH).

## Commits

See `git log develop..tb-viewer`. (The two plan docs were already tracked on
`develop` by d2bc10a0 / b1905766, so there was nothing to add for them.)

## What was built

Backend
- `src-tauri/src/services/tfevents.rs` (+ `tfevents/tests.rs`): TFRecord framing,
  CRC32C + masked CRC, protobuf reader, `scan(bytes, from)`, min/max
  `downsample`. No crate. Pure, panic-free, bounded (16 MiB record skip, 200k
  points/tag, 2000 tags, 256-char names).
- `src-tauri/src/commands/tfevents.rs` (+ tests): `tfevents_read`
  (cursor-resumed read, 24 MiB window per call, `truncated` = call again) and
  `tfevents_discover` (event files under a folder: 3 levels, 64 files, 512
  folders, links never followed). Both `Core`, `BodyConfined`.
- `commands/fs.rs`: the remote-vs-local decision of `read_file_bytes_any` moved
  into `byte_route` (so the byte readers share one guard), plus
  `read_range_routed` / `read_range_local` / `read_range_opened`.
  `read_file_bytes_any` behaves as before.
- `services/remote/sftp.rs`: `read_range_on` and one-shot `read_range`.
- Registrations: `lib.rs`, `commands/mod.rs`, `services/mod.rs`,
  `command_class.rs`, `core_dispatch.rs` (USER_CONFINED rows), regenerated
  `src/lib/transport/commandClasses.ts`.

Frontend
- `lib/viewers/tensorboard.ts` (+ `__tests__/viewers/tensorboard.test.ts`): runs,
  merge-by-step, tag groups/filter, debiased EMA, ticks, run colour slots.
- `components/embed/TensorBoardView.tsx`, `components/embed/tensorboard/ScalarChart.tsx`
  (+ `__tests__/viewers/TensorBoardView.test.tsx`), `styles/tensorboard.css`.
- Detection by name prefix in `fileUtils.naturalViewerFor`, registry row
  `viewerType.tensorboard` (opt-out works; no text fallback, the bytes are binary).
- "Open as training runs" in the folder context menu of `FileTree.tsx`
  (`openTrainingRuns` in `lib/files/openFileEntry.ts`, which now shares one
  `placeEmbedTab` with `openFileEntry`).
- `UntestedTag` rows `viewer.tensorboard`, `viewer.tensorboard.runs`,
  `viewer.tensorboard.live`; English keys `tensorboard.*`; file-map rows.

## Choices where the plan was silent

- **No binary fixtures.** No PyTorch/TensorFlow/tensorboardX is installed, so the
  tests build event files byte by byte with a small encoder. Nothing to add to
  `scripts/privacy-reviewed-binaries.txt`. The CRC vectors are RFC 3720's plus
  masked values computed with an independent Python implementation.
- **Folder discovery is a backend command**, not the frontend's `list_dir`
  walk. `list_dir` takes `(projectDir, relPath)` and always lists the host for a
  remote project, so a viewer holding an absolute mirror-or-host path would have
  had to re-derive which side it is on. `tfevents_discover` takes the same
  `(path, projectId)` as `tfevents_read`, goes through `byte_route`, and does the
  3-level / 64-file walk in one round trip. Remote discovery needs the pooled
  session (it never dials a one-shot).
- The viewer for a folder is the same `tensorboard` embed tab with the folder as
  `embedPath`; the view decides file vs folder by the name prefix.
- **Non-finite values** (NaN/inf) are counted and shown in the footer, not sent
  (JSON cannot carry them).
- **Chunking:** a read takes at most 24 MiB; `truncated` tells the frontend to
  call again at once, so a 300 MB file loads in ~13 calls with a progress
  percentage. Per call each tag is cut to 1,500 points (min/max); the frontend
  thins a series again past 6,000 points (to 3,000).
- A cursor beyond the end of the file waits (an oversized record the writer is
  still filling). A file that got smaller restarts from byte 0 and the answer
  carries `reset: true`.
- **Colours:** the eight-slot categorical palette from the dataviz skill, as
  `--tb-series-1..8` in `styles/tensorboard.css` (dark set by default, light
  set under `[data-theme="light" | "fancy_light" | "light_lavender"]`). The
  validator passes in both modes; in light mode three slots are below 3:1
  contrast, which the skill answers with visible names (legend chips, tooltip)
  and a table (the enlarged chart's "Show the values as a table"). A ninth run
  and beyond reuse the slots with a dash pattern rather than a new hue.
- The hidden-pane / disconnected gates: the viewer checks `usePaneVisible()` and
  the project's SSH state itself, and `FileViewerPane` also shows its existing
  "Not connected" hold for a disconnected host.

## Gotchas

- `scan` returns `next_offset` that may lie beyond the bytes it was given (a
  skipped oversized record). The command treats `offset >= size` as "wait".
- The sftp handle's `read` advances its offset by the bytes *requested*, so
  `read_range_on` seeks before every request.
- A file rewritten to a size at least as large as before is not detected as
  replaced (no content check); the CRC stop then shows "reading stopped at a
  damaged record". Reopen the tab / Refresh does not reset it either; closing and
  reopening does.

## Gate results

Run on a heavily loaded machine (load average 60-100 from other sessions), so
`scripts/gates.sh`'s `vitest` step timed out workers in two runs; each failed
file passed when re-run alone and the final full run was clean except for one
real finding (below, fixed).

- `scripts/brand-check.sh`, `git diff --check`: pass.
- `npm run lint`: 0 errors, no warnings in the touched files (the repo's other
  advisory warnings are unchanged).
- `npm run build` (tsc + desktop, mobile, web bundles): pass.
- Full `npx vitest run`: 1083 files / 11,133 tests passed. The one failure was
  `theme/TypeScale` (my `px` font sizes in `tensorboard.css`); fixed to tokens
  and re-run with the theme folder and the viewer tests: 196 tests pass.
  New tests: `tensorboard.test.ts` (31), `TensorBoardView.test.tsx` (8),
  3 detection tests in `InternalViewer.test.ts`.
- `cargo clippy -p tabtivity -p app-serverd --all-targets -- -D warnings`,
  `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`,
  `cargo clippy -p app-serverd --all-targets -- -D warnings`: pass.
- `cargo test -p tabtivity -p app-serverd`: 5142 + 143 + 38 + 1 passed, 0 failed
  (34 of the lib tests are the new `tfevents` ones).
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`
  (the daemon build): 4972 + 1 passed, 0 failed.
- `UPDATE_COMMAND_CLASSES=1 ... the_generated_command_classes_ts_is_current`
  regenerated `commandClasses.ts` (two `core` rows).
- Not run: `cargo test --workspace` as a separate invocation (src-core and
  src-gateway are untouched), `scripts/privacy-check.sh` beyond the pre-commit
  hook, `ci-local.sh` / cross-OS checks. Rust tests use `Path::join` and
  `tempfile`; none hardcode `a/b` paths.

## Flagged for user

- Not run live in the app. Everything is unit/integration tested only.
- "Open in TensorBoard..." footer link from the plan is **not** built: it depends
  on the localhost-viewer plan, which has not landed.
- Phase 2 and later (images, text, hparams, histograms, phone) not built; the
  footer only counts them.
- No real PyTorch/TF file was tested against the parser (none installed);
  wire-format details (field numbers, packed vs unpacked floats, TF2 metadata)
  come from the TensorBoard protos as remembered, so the manual QA in the plan
  (todo 2428) is where a mismatch would show first.
- The four other locales (de, es, fr, it) carry hand-written translations of the new keys (the i18n test requires every key in every language); worth a native glance.
- `todo/*.md` untouched, as asked; the QA item (todo 2428) is for you to tick.
