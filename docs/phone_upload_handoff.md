# Phone upload — implementation handoff

Running log of the plan's agent steps (`docs/phone_upload_plan.md`). Each
step appends its own section.

## Step A

Commit: see `git log --oneline -- src-tauri/src/services/mobile_control/uploads.rs`
(the `feat(mobile): phone uploads service …` commit on `phone-upload`).

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
