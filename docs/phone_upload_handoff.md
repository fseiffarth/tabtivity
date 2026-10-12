# Phone upload — implementation handoff

Running log of the plan's agent steps (`docs/phone_upload_plan.md`). Each
step appends its own section.

## Step A

Commit: `a3d10611` (`feat(mobile): phone uploads service — add-only writes
into a browsed folder`) on `phone-upload`; this handoff's sha line in the
`docs(mobile)` commit after it.

### What landed

- `services/mobile_control/uploads.rs` (new, `pub mod uploads;` in `mod.rs`).
- `files.rs`: `ProjectDir::open` is `pub(super)` (Unix); `files_windows.rs`:
  `pub(in crate::services::mobile_control)`. Module docs point at `uploads.rs`.
- `inbox.rs`: `pub(super) fn create_unique(dir: &ProjectDir, base: &str,
  bytes: &[u8]) -> std::io::Result<String>` (the old `store_at` loop;
  `store_at` keeps stamp + total cap and calls it). `safe_name` appends `_`
  to a Windows device head (`CON.txt` → `CON_.txt`, `nul` → `nul_`,
  `com1.tar.gz` → `com1_.tar.gz`) on every OS.

### API for step B (exact signatures)

```rust
use crate::services::mobile_control::uploads;

pub const LOG_FILE: &str = "phone-uploads.jsonl";      // in <state_dir>/mobile-control/
pub const MAX_UPLOADS_PER_DAY: u64 = 1 GiB;
pub fn uploads_open(state_dir: &Path) -> bool;          // files_open && project_uploads == true
pub fn accepts(rel_dir: &str) -> bool;                  // no segment starts with '.'; "" = root
pub fn store(state_dir: &Path, root: &Path, raw_id: &str, rel_dir: &str,
             raw_name: &str, bytes: &[u8], phone: Option<&str>) -> Result<Landed, UploadError>;
pub fn undo(state_dir: &Path, root: &Path, raw_id: &str, rel: &str) -> Result<(), UploadError>;
pub fn find(state_dir: &Path, id: &str) -> Option<Record>;   // desktop undo: id -> record
pub fn recent(state_dir: &Path, within: Duration,
              root_of: impl Fn(&str) -> Option<PathBuf>) -> Vec<Record>;  // newest first, intact only

pub struct Landed { pub id: String, pub name: String, pub rel: String, pub size: u64 }
pub struct Record { pub id, pub project /* raw id */, pub rel, pub size: u64,
                    pub sha256, pub at: u64, pub phone: Option<String> }  // Serialize + Deserialize
pub enum UploadError { Off, Refused, Empty, TooLarge, Full, Unavailable, NotFound, Io(String) }
```

`UploadError::code()`: `Off` `uploads_off` · `Refused` `upload_refused` ·
`Empty` `empty_file` · `TooLarge` `file_too_large` · `Full` `uploads_full` ·
`Unavailable` `project_unavailable` · `NotFound` `file_not_found` ·
`Io` `write_failed`. `store` never returns `Off`/`NotFound` (the switch is
the route's check — use `UploadError::Off.code()` there); `undo` returns only
`NotFound` or `Io`.

Desktop `phone_upload_undo(id)`: `find(state_dir, &id)` → root of
`record.project` (`remote::project_directory`, refuse remote) →
`undo(state_dir, &root, &record.project, &record.rel)`. A missing record →
`file_not_found`.

### Choices the plan left open

- `store` maps `ProjectDir::open` errors: `FilesError::Unavailable` (root
  gone) → `Unavailable`; everything else (missing folder, a file, a link,
  invalid rel) → `Refused`. Checks run in order empty → too large → dot
  segment → walk → cap.
- If the log append fails, the just-created file is removed again and the
  upload is `write_failed` (an unlogged file could be neither listed, undone,
  nor counted against the cap).
- Compaction also runs when any log line is garbage (not only when the first
  line is older than 7 d); it rewrites via `store::write_bytes_atomic(.., 0o600)`
  before the new line is appended. The log is created `0o600` +
  `O_NOFOLLOW` on Unix inside the `0700` control dir.
- `recent`'s cache is keyed by `(record id, root)` rather than `(raw_id,
  rel)`: two records may name the same `rel` (undo, then the same name
  uploaded again) with different hashes. Each call keeps only the entries it
  saw, so the cache is bounded by the log window.
- `undo` accepts any record of that project + `rel` whose size + hash match
  the file now (newest first), so a name freed by an undo and reused works.
- `phone` is cut to 64 characters (chars, not bytes).
- `find` added (not in the plan) so step B's desktop undo needn't parse the log.

### Gotchas for later steps

- The cap counts the log only: an undone upload still counts for 24 h.
- `uploads_open` already includes `files_open`; the route needs only
  `files_scope` (which checks `files_open` for `files_off`) then
  `uploads_open` for `uploads_off`.
- `store` takes the sidecar-wide log mutex; run it under `spawn_blocking`.
- `recent`/`undo` hash files up to 24 MiB each; run them off the async
  runtime too.

### Gates

All green (Linux): `scripts/gates.sh` — brand, whitespace, clippy (tabtivity +
app-serverd, all targets, `-D warnings`), clippy daemon lib
(`--no-default-features`), clippy app-serverd, `cargo test -p tabtivity -p
app-serverd`, daemon test (`--no-default-features --lib --test
server_secrets`). Lib tests: 3875 passed / 4 ignored (desktop), 3777 passed /
4 ignored (daemon build); `uploads` 15 + `inbox` 17 on Linux (Windows adds 3
`#[cfg(windows)]` twins, which only compile here). Windows cross-check (msvc
shims): `cargo clippy --target x86_64-pc-windows-msvc --all-targets -D
warnings` and `cargo check --workspace --all-targets` both clean; macOS
`cargo check --workspace --all-targets --target aarch64-apple-darwin` clean
(only the vendored `tauri-runtime-wry` patch's existing `unused_unsafe`
warnings). Windows tests themselves have not run (CI will).

### Flagged for user

- An undo checks the file against *any* log record of that project + path
  (newest first), not only the one whose id the desktop row carries; with
  identical bytes uploaded twice under one freed name both rows resolve to
  the same file. Harmless (the file is still one this feature wrote,
  unchanged), noted for the reviewer.

### Review A

Reviewed `0c1c995c..1a4b719c` (`uploads.rs`, the `inbox.rs` refactor,
`files.rs` / `files_windows.rs` visibility, `mod.rs`). Fixes in `bf68dc78`,
each with a regression test:

- **`create_unique` underflow** (pre-existing in the inbox, now reached by
  uploads too): `safe_name` keeps a dotted tail past 12 characters whole, so
  `a.<78 × 𝐀>` reached `create_unique` with a 313-byte "extension";
  `255 - 5 - ext.len()` underflowed — a panic under overflow checks (tests,
  debug), an over-long name and `write_failed` in release. A tail that leaves
  the stem no byte is now cut as part of the stem (no trailing dot left).
  Test: `inbox::a_long_dotted_tail_in_a_wide_script_still_lands`.
- **Device names**: `COM¹ COM² COM³ LPT¹ LPT² LPT³` (Win32 reads the
  superscripts as port digits) and `COM0`/`LPT0` (Microsoft's reserved list)
  passed `safe_name`. Added to `a_windows_device_name_gets_an_underscore_on_every_os`.
- **Torn log line blinded the log**: `read_log` used `read_to_string`, so one
  line cut inside a multi-byte character (a short append on a full disk;
  `phone` labels are not ASCII-escaped) made the whole log read as empty —
  the cap counted nothing, `recent`/`find`/`undo` saw nothing, and no
  compaction ever ran to heal it. Now parsed as bytes per line; the torn line
  is one garbage line, dropped at the next write. Test:
  `uploads::a_line_torn_mid_character_does_not_blind_the_log`.
- **Two desktop rows for one file**: the same bytes uploaded again under the
  name an undo freed left two intact records; `recent` now lists one row per
  `(project, rel)`, the newest intact record. Test:
  `uploads::recent_lists_one_row_per_file`.

Checked and fine: the openat/`O_NOFOLLOW` (Windows `FILE_OPEN_REPARSE_POINT`)
walk is held from before the cap check to the write; `O_EXCL`/`FILE_CREATE`
never opens an existing name or link; `accepts` sees only `valid_rel` paths
from sealed tokens (no forged `GITHUB~1`-style short names); log lines are
JSON-escaped (no injection); cap check, create and append share `LOG_LOCK`;
`inbox::store_at` behaves as before apart from the device rename (only its
`Io` text changed); cfg gating and `/`-joined test rels are cross-OS.

#### Verdicts on flagged items

- *Undo matches any log record of that project + path* (implementer):
  **harmless, keep.** Whatever record matches, the file is one this feature
  wrote, byte-for-byte unchanged — decision 7's test. Its one visible effect,
  two desktop rows for one file, is fixed above.

#### Flagged for user (not changed)

- **Undo race (hash → unlink by name).** `undo` hashes the file, then
  `unlinkat`s the name. An editor's atomic save (rename over) landing in that
  window — milliseconds, up to 24 MiB of hashing — is deleted although it
  changed. Unix has no unlink-if-same-inode; a `(dev, ino)` re-check right
  before `unlinkat` would narrow it to microseconds. On Windows it can be
  closed outright: open the leaf once with `DELETE`, hash through it, set the
  disposition on that handle. Worth doing in step B or a follow-up?
- **Non-dot files tools run.** Decision 4's dot rule keeps uploads out of
  `.github`/`.cargo`/…, but a non-dot name in a plain folder can still be
  picked up by tooling: `tests/conftest.py` (pytest imports it), a root
  `build.rs` or `Makefile` in a project lacking one (a clash only suffixes).
  Within the threat notes (the paired phone already has shells); noted only.
- **The cap counts bytes, not files.** 1-byte uploads are bounded only by the
  request rate; each adds a log line, and every upload reads the whole log.
  Fine for a trusted paired phone; a per-day file count would bound it.

#### Gates (after `bf68dc78`, Linux)

`scripts/gates.sh`: brand, whitespace, clippy (tabtivity + app-serverd, all
targets), clippy daemon lib, clippy app-serverd, `cargo test -p tabtivity -p
app-serverd`, daemon test — all PASS (frontend gates skipped, no frontend
change). Lib tests 3878 passed / 4 ignored (+3); `uploads` 17, `inbox` 18.
Windows cross-check: `cargo clippy --target x86_64-pc-windows-msvc
--all-targets -D warnings` (msvc shims) clean. macOS not re-checked (no
cfg'd code changed). Windows tests not run (CI). Not run live.

## Step B

Commit: `6342e18a` (`feat(mobile): phone upload routes and desktop upload
commands`) on `phone-upload`; this section in the `docs(mobile)` commit after it.

### What landed

- `host.rs`: route `/api/v1/projects/{project_id}/files/upload` =
  `delete(project_files_upload_undo).merge(post(project_files_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE)))`;
  shared guard `upload_scope` (authenticate → `exact_origin` → `files_scope`
  → `uploads::uploads_open`); `upload_error` maps codes to statuses; the
  folder listing gains `uploads`; `project_files_raw`'s doc fixed.
- `commands/mobile_control.rs`: `phone_uploads_list`, `phone_upload_undo`
  (both async, `spawn_blocking`, no `AppHandle`), registered in `lib.rs`,
  `Core` rows in `command_class.rs`, `commandClasses.ts` regenerated.
- Host test `upload_here_adds_a_new_file_to_a_plain_folder_and_undoes_only_it`;
  both routes added to the per-phone scoping test's `routes`.

### For agent D (phone) — routes

All need the session cookie and the exact `Origin` (else `403 invalid_origin`).

- `GET /api/v1/projects/{id}/files[?dir=<token>]` → the listing as before plus
  `"uploads": bool` (switch on **and** no dot segment in the folder; the root
  is `true` when on). An older host omits it.
- `POST /api/v1/projects/{id}/files/upload?name=<file name>[&dir=<folder token>]`,
  raw body = the file (no `dir` = project root) → `201 { "file": <listing
  entry: token, name, kind, size, modified, created?> }`. The `name` may
  differ from the phone's (`safe_name`, `-2` on a clash).
- `DELETE /api/v1/projects/{id}/files/upload?f=<file token>` →
  `200 { "undone": true }` (**not 204** — `api()` throws
  `malformed_response` on an empty body).
- Errors `{ "error": code }`: `files_off` 404, `uploads_off` 404 (both routes,
  undo too), `project_not_found` 404, `files_unavailable` 404,
  `file_not_found` 404 (forged/stale `dir`/`f` token, undo of an edited /
  unlogged / gone file), `upload_refused` 403 (dot folder, a token naming a
  file or a link), `empty_file` 400, `file_too_large` 413 (also axum's own
  413 past 24 MiB, no JSON code — map a 413 without `error` the same),
  `uploads_full` 507, `project_unavailable` 409, `write_failed` 500.

### For agent C (desktop) — commands

- `invoke<PhoneUpload[]>("phone_uploads_list")` — no args; newest first,
  last 24 h, only files still intact on disk, one row per file; projects that
  are unknown or remote now are left out. Row (camelCase):
  `{ id: string, projectName: string, rel: string /* "/"-separated */,
  size: number, at: number /* unix s */, phone?: string }`.
- `invoke("phone_upload_undo", { id })` → `Promise<void>`; rejects with the
  code string, practically always `"file_not_found"` (unknown id, gone or
  remote project, file edited/moved) or `"write_failed"`.
- Both class `core` (as `global_inbox_list/delete`).

### Choices made where the plan left room

- Undo answers `200 { "undone": true }` instead of the plan's `204` (see
  above).
- Undo is gated by the switch too (`uploads_off` once it is off), as "same
  guards" read; the desktop undo is not gated (it is the user's own notice).
- Row field is `projectName` (camelCase, the frontend's convention), not
  `project_name`.
- Project names come from `commands::projects::read_projects_list()` (read
  only) rather than `get_projects()`, which rewrites `projects.json` on every
  call — wrong for a 10 s poll.
- A landed file whose row `files::entry` cannot build answers `404
  file_not_found` (plan), although the file is on disk; `safe_name` never
  yields a hidden name, so this is unreachable short of a race.
- The device label is looked up per upload under one auth lock with the
  host key (`AuthStore::devices()`), so a renamed phone logs its new name.

### Gates (Linux, after `6342e18a`)

`scripts/gates.sh`: brand, whitespace, lint-fe, clippy (tabtivity +
app-serverd, all targets), clippy daemon lib, clippy app-serverd, `npm run
build`, vitest `--changed`, `cargo test -p tabtivity -p app-serverd`, daemon
test — all PASS. Lib tests 3879 passed / 4 ignored (desktop, +1), 3781 / 4
(daemon build). Windows cross-check `cargo clippy --target
x86_64-pc-windows-msvc --all-targets -D warnings` (msvc shims) clean; macOS
not re-checked (no cfg'd code). Not run live; `npm run backend:stale` not run
(worktree, no running window of this branch).

### Flagged for user

- The plan's open item from review A — the hash→unlink race in `undo` — is
  unchanged (step B only calls `uploads::undo`).
- A body past 24 MiB is refused by axum's `DefaultBodyLimit` before the
  handler runs: a 413 with a plain-text body, not `{ "error":
  "file_too_large" }`. The phone pre-checks `MAX_INBOX_FILE`, as the inbox
  does, so only a stale build sees it.
