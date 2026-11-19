# SyncTeX on remote projects — plan

Status: implemented for host PDFs and local mirrors. Live SSH verification is pending.

## Why

SyncTeX (Ctrl+click from source to PDF and back) does nothing on a remote
project's **Remote side**. The viewer shows `pdfViewer.syncRemoteMsg` ("open the
local mirror copy") and makes no SyncTeX call:

- forward search: `src/components/embed/fileViewer/TexView.tsx` `revealInPdf`
  returns early on `remoteSource`;
- reverse search: `src/components/embed/pdf/usePdfReverseSearch.ts` skips the
  map probe (`syncable = false`) and answers every click with the `remote`
  notice;
- backend: every `synctex_*` command (`src-tauri/src/commands/synctex.rs`)
  confines the PDF to the project's **local** roots and `services::synctex`
  reads the map with `std::fs`.

The host build (`compile_tex_host`, `src-tauri/src/commands/tex/host.rs`)
already passes SyncTeX to latexmk and builds with `-cd`, so after every host
compile a `<stem>.synctex.gz` sits beside the PDF **on the host**. The data
exists; only the reader cannot reach it. The mirror workaround needs the map
byte-synced, which is opt-in per path and rarely set up.

## Decisions

1. **Fetch the map over SFTP and read it in memory with the existing native
   reader.** The `synctex` CLI on the host is out: it was removed
   because it picks the wrong `.tex` file, the host may lack it, and it would
   run a program on the host for each click. Requiring byte-sync is out too:
   it needs the user to set it up by hand. No local file is written: the map
   is project content, so it stays in the reader's memory cache.
2. **One reader, two path worlds.** `services::synctex` stays the single
   implementation. Disk access is pulled behind a small seam: map bytes and
   stamp, file mtimes, and path canonicalisation. A local and a remote
   implementation sit behind it. The parsing, box picking and forward rules
   do not change.
3. **Paths stay host paths.** A Remote-side viewer already names files by
   their absolute host path, and the map records host paths, so no
   local↔remote translation is needed. What remains is the re-rooting that
   `Spelling` does for symlinks, done with SFTP `canonicalize` instead of
   `std::fs::canonicalize`.
4. **Routing is the `file_size`/`file_mtime` rule**: a `remote_target_for(pid)`
   and a path not under the mirror (`remote_sync::is_under_mirror`) take the
   remote branch. Everything else is local, unchanged.
5. **Ask nothing while disconnected.** The frontend keeps the `remote` notice
   (reworded) when the project's SSH session is down, and only then.

## Steps

### 1. Seam in `services::synctex` (pure refactor)

`src-tauri/src/services/synctex.rs`:

- Split `load_map` into "get stamp + bytes for a path" and "parse/cache".
  `read_map`'s caps (`MAX_MAP_BYTES` compressed and inflated, regular files
  only) move to a `parse_map(bytes, is_gz, cap)` both worlds call.
- Cache key becomes an enum, `Local(PathBuf)` or
  `Remote { project_id, path: String }`, with the same `(mtime, size)` stamp.
  It stays a single entry.
- Give `Spelling` a constructor from precomputed roots:
  `Spelling::from_roots(base, Vec<(spelled, canonical)>)`. Give it a
  `canonical` callback in place of the direct `std::fs::canonicalize` in
  `absolutise`. The remote version answers from the roots alone, lexically
  (`lexical_clean`, then re-root), with no per-input round trip.
- `input_tags`' `!only.exists()` and `stale_inputs`' `mtime_of` already take a
  closure or can take one. Route both through the seam.
- `resolve`, `view`, `page_lines`, `status` and `resolve_pages` get `_in`
  variants that take the loaded map, the `Spelling` and the mtime closure. The
  current local entry points become thin wrappers over them.

Done when: `cargo test -p tabtivity --lib synctex` passes unchanged, with no
behaviour change on local projects.

### 2. Remote map loader

New `src-tauri/src/services/synctex/remote.rs`, or a section in
`commands/synctex.rs` if it stays small. It is async and uses the pooled SFTP
session from `services::remote::pooled_sftp`, falling back to a one-shot
session as `commands/fs.rs` `remote_read` does:

- `confine_remote_abs(&target.spec.remote_path, pdf)` (`commands/fs.rs`), then
  the same for each map candidate (`map_candidates`).
- `metadata_opt_with_mode_on` on `<stem>.synctex.gz`, then `<stem>.synctex`.
  Take the first that is a regular file. A symlink is canonicalised and
  confined like the local `confine_pdf` does, and refused if it lands outside
  `remote_path`.
- Compare the stamp with the cache. Only on a miss, `read_file_up_to(…,
  MAX_MAP_BYTES)` then `parse_map`.
- Roots for `Spelling`: SFTP `canonicalize` of the PDF's directory and of each
  ancestor up to `remote_path`, which is a few round trips. Cache them with the
  map. Add a `canonicalize_on` helper beside `metadata_on` in
  `src-tauri/src/services/remote/sftp.rs` (openssh-sftp-client's
  `Fs::canonicalize`).
- `status`: the PDF's and each candidate source's mtime come from
  `metadata_on`, which gives host times on both sides, so clock skew cannot
  matter. Stat only the `SOURCE_EXTS` inputs that pass `lexically_within`
  (the same filter as today), sequentially over the pooled session.

Done when: a unit test feeds a recorded `.synctex.gz` fixture through the
remote path. `parse_map`, `Spelling::from_roots` and a fake mtime closure must
give the same `resolve`/`view`/`status` answers as the local path for the same
tree, including a symlinked base.

### 3. Commands route

`src-tauri/src/commands/synctex.rs`: each of the four commands takes `ctx:
Ctx` (as `file_size` does, `ctx.get::<RemotePoolState>()`) and branches:

```
remote_target_for(pid) && !is_under_mirror(pid, &pdf)  → remote loader + *_in
otherwise                                               → today's on_confined_pdf
```

Parsing and the search still run in `try_blocking` once the bytes are in hand.
A map of tens of MB must not inflate on the async runtime. The command
signatures gain only `ctx`, so `commandClasses.ts` needs no regen. Check the
existing rows in `services::command_class` still hold, and regenerate if the
test says so.

Done when: `cargo test -p tabtivity --lib` and both clippy variants are green,
and the daemon build (`--no-default-features`) still compiles the commands.

### 4. Frontend: drop the early returns

- `usePdfReverseSearch.ts`: on `remoteSource`, probe the map once per disk
  change through `synctex_status`, not two `texPathExists` calls. One SFTP
  stat pair beats two IPC round trips. Gate the probe on the project's SSH
  state from `stores/remote/remoteStatus.ts`, and on `PaneVisibleContext`, as
  the `file_mtime` polls already are. Clicks then run the normal path.
- `TexView.tsx` `revealInPdf`: remove the `remoteSource` early return. Keep
  only a disconnected branch, which shows the notice and asks nothing.
- `SYNC_NOTICE_MSG.remote` / `pdfViewer.syncRemoteMsg` in `src/lib/i18n/en.ts`:
  reword to "connect to the host to jump between source and PDF". Keep the key.
  Retire `pdfViewer.syncRemoteOpenedMsg` if nothing words it any more.
- Clicks during a host build: the existing `pdfSync` compile-running notice
  already holds them. Confirm that `compile_tex_host` sets it, as the local
  compile does.
- Untested register (`src/lib/untested.ts`): rewrite `pdfViewer.syncRemoteMsg`
  for the disconnected case. Add `pdfViewer.syncRemote` for "forward and
  reverse search work on a Remote-side PDF built on the host" with the pill on
  the notice area of both viewers.

Done when: `TexSync.test.ts`, `PdfSyncGeometry.test.tsx` (source
`"remote"`, connected and disconnected) and `TexViewer.test.tsx` cover both
branches, and `npm run build` and `npm test` are green.

### 5. Docs

- `docs/filemap_backend.md` rows for `synctex.rs` (both): local and remote
  path worlds.
- `docs/filemap_frontend.md` `TexView.tsx` / `usePdfReverseSearch` mention only
  if a row names the remote refusal.
- `docs/help/` TeX topic: if it says SyncTeX is local-only, correct it.

## Out of scope

- **Phone markup** (`services::mobile_control::markup` → `resolve_pages`).
  `markupGate` hides Mark up on remote projects entirely. Lifting that is its
  own plan. The `_in` variants from step 1 make it cheap later.
- **Deck page lines** (`synctex_page_lines`) come along for free through step
  3. No deck UI work.
- **Host-pinned local projects** (TexView's other `compile_tex_host` caller).
  The host build returns an absolute host PDF beside the source and uses the same remote project target. If it is on the host under a path the viewer
  reads as `"remote"`, it is covered. If not, note it here and leave it.

## Risks

- **Map size.** A thesis map is 1–10 MB compressed and is fetched once per
  build, not per click, thanks to the stamp cache. On a slow link the first
  click after a compile waits for the fetch. The click shows the existing
  pending state. There is no prefetch on reload unless live use says it is
  needed.
- **Attacker-controlled map.** The rules are unchanged: compressed and inflated
  caps, regular file only, confined to `remote_path`. Input paths are only
  lexically compared and canonicalised through the cached roots, never stat'ed
  wholesale. A reverse-search answer outside the project fails at the
  confined read when the editor opens it, as it does locally.
- **Session freeze.** Every SFTP call here is async over the pool. Nothing sync
  touches the session (AGENTS.md: gate remote probes on connected).

## Verification

Gates: `scripts/gates.sh` for the touched set (Rust and TS both).

Live, by the user (never run by an agent). On a remote project, Remote side:

1. Open `main.tex`, Compile (host build), and the PDF opens.
2. Ctrl+click a paragraph in the source. The PDF scrolls to it and highlights
   the line.
3. Ctrl+click a word in the PDF. The editor jumps to its line, in the same tab
   (no duplicate tab from a symlinked home on the host).
4. Edit a line above, save, and Ctrl+click without compiling. The stale notice
   appears and the jump still happens.
5. Disconnect SSH and Ctrl+click. The "connect to the host" notice appears and
   the window does not freeze.
6. Repeat 2–3 on the local mirror side. Behaviour is unchanged.
