# Phone → project upload ("Upload here") — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Status: plan, approved by the user 2026-10-12; implementation by the
plan + implement + review routine (handoff: `docs/done/phone_upload_handoff.md`).

## Why

Today a document sent from the phone lands only in the project's hidden,
git-ignored drop box (`<project>/.tabtivity/inbox/<stamp>-<name>`, `inbox.rs`) —
the right place for "show this to the agent", the wrong one for "this belongs
in the project". The user asked to load documents from the phone into the
project directly. The phone's read-only project-files browser (📁,
`files.rs` / `ProjectFiles.tsx`, QA 31bo) already lets them stand in a folder;
**Upload here** puts the picked files into that folder.

The folder the user stands in is the consent (`feedback: nothing auto-files
into a project`): nothing else on the phone or desktop writes into a visible
project folder.

## Fixed decisions

Not up for review — the reviewers fix bugs, not these.

1. **One new route, in the files browser.** No "Move from inbox", no
   composer change, no remote/box/root-console variant. The inbox keeps its
   job unchanged.
2. **Separate host-wide switch** `tabtivity_mobile_host.project_uploads`
   (key under `crate::brand::MOBILE_HOST_KEY`, default **off**), read from
   `settings.json` per request like `files::files_open`. It only takes
   effect while `project_files` is also on (the upload names its folder by a
   browser token). Desktop settings show it as a dependent checkbox under
   *Project files*, disabled while that one is off.
3. **Add-only.** The route creates a new file; it never overwrites, renames,
   or deletes anything — except the undo of a file *this feature itself
   wrote*, while it is byte-for-byte unchanged (decision 7).
4. **Into an existing folder only.** The target folder is a sealed browser
   token (`files::unseal`); no folder is created. Every segment of the folder
   path and the leaf must be a plain segment, **no segment may start with
   `.`** (that refuses `.git`, `.github/workflows`, `.cargo`, `.vscode`,
   `.tabtivity`, `.env*` …), and the walk is the `ProjectDir` openat /
   `O_NOFOLLOW` walk from the root — no link followed anywhere.
5. **The phone's name, kept.** Unlike the inbox there is **no stamp**: the
   leaf is `inbox::safe_name(raw)` (never starts with a dot, safe alphabet,
   bounded, extension kept). A clash becomes `stem-2.ext`, `stem-3.ext`, …
   via `create_file` (`O_EXCL`) — same loop as `inbox::store_at`; factor the
   shared loop out instead of copying it.
6. **Limits.** 24 MiB per file (`inbox::MAX_INBOX_FILE`, route-level
   `DefaultBodyLimit`); a rolling cap of 1 GiB written by this feature per
   project per 24 h (from the upload log, decision 7) → `uploads_full`.
   Empty body → `empty_file`. Files are created `0o666 & umask` (no
   execute bit) — `create_file`'s existing mode.
7. **Upload log, advisory.** Each landed file appends one JSON line to
   `<state_dir>/mobile-control/phone-uploads.jsonl`: `{ id, project (raw id), rel,
   size, sha256, at (unix s), phone (device label, if the auth layer has
   one) }`. Only the writer (the sidecar) appends; it drops lines older than
   7 days when it rewrites (temp + rename). The **disk is the truth**: a
   record counts only while the file at `rel` still exists, is a regular
   file reached without links, and has the same size + sha256. A record
   whose file was edited, moved or deleted silently drops out. Nobody marks
   records "undone".
8. **Undo.** Phone: the landed row offers **Undo** while it is on screen
   (`DELETE /api/v1/projects/{id}/files/upload?f=<token>`). Desktop: the
   header **inbox indicator** (`InboxIndicator.tsx`, files the phone sent)
   gains a section *Added to projects* listing records from the last 24 h
   with project name, relative path, size, age; **Undo** (desktop command)
   and **Keep** (hides the row; per-viewer `localStorage` via
   `storageKey`, wrapped in try/catch). Both undos call the same service
   function, which deletes only a logged, unchanged file (decision 7);
   anything else is `file_not_found`. The indicator still renders only
   while something is listed (global inbox files *or* recent uploads).
9. **Listing tells the phone.** The folder listing answer gains `uploads:
   bool` (switch on *and* folder accepts uploads, i.e. no dot segment), so
   the phone never shows a dead button.
10. **Nothing else changes in git/sync.** The file lands untracked; no
    auto-add, no commit, no sync push. Mobile scopes are local projects only
    already (`discovery::mobile_local`), and `files_scope` already refuses
    boxes and the root console.
11. **Tags.** Untested ids `mobile.files.upload` (phone) and
    `desktop.inbox.phoneUploads` (desktop indicator section), rows in
    `src/lib/untested.ts`. QA entry in `todo/group-h-crossplatform.md` beside
    31bo with the four platform ✅/❌ pairs.

## Threat notes (why this is acceptable)

A paired phone can already type into shells and agent tabs, so a hostile
phone session gains nothing it lacked. The real risk is a private document
one `git add -A` away from a public remote — answered by the user choosing
the folder, the desktop notice with Undo, and nothing being auto-committed.
Dot-folders are refused because a new file there can change what tools run
(`.cargo/config.toml`, `.github/workflows/*.yml`, `.envrc`); exec_trust
already gates `latexmkrc` and git hooks.

## Code facts the steps rely on (checked 2026-10-12)

- The sidecar is a **separate process** (the Tabtivity binary run with
  `--mobile-host`, `commands/mobile_control.rs`); the desktop commands run in
  the window's process. So the log has one writer process (the sidecar's
  `host.rs` routes) and one reader process (the desktop): the desktop never
  writes the log, its undo only deletes the file (decision 7).
- `files::hidden` hides only `.git`, `.tabtivity` and `.env*`; every other
  dot-folder (`.github`, `.cargo`, `.vscode`, …) **is listed** and gets a
  token. Decision 4's dot rule is what keeps uploads out of them.
- `ProjectDir::open(root, rel)` is private on Unix (`files.rs`) and
  `pub(super)` (= `files` only) on Windows (`files_windows.rs`);
  `create_file`/`remove_file`/`open_file`/`entries` are already reachable
  from `mobile_control` on both. Windows `create_file` is `NtCreateFile`
  `FILE_CREATE` with `OBJ_CASE_INSENSITIVE` (a case-only clash is
  `AlreadyExists` → suffix), no mode bits (the folder's ACL is inherited).
- `inbox::safe_name` keeps Windows device names (`CON.txt`, `nul`, `COM1.log`):
  created handle-relative they land as real files Explorer cannot open or
  delete.
- **The settings schema drops unknown mobile-host keys.** `patch_settings`
  round-trips `settings.json` through `schema::settings::AppMobileHostSettings`,
  which has no `project_uploads`, no `browser_client` and no `#[serde(flatten)]`
  catch-all — so a new switch written by the desktop is erased on the very
  write that sets it (and the desktop's *Browser access* switch,
  `browser_client`, is already lost that way: sibling bug, fixed in step 3).
- `MobileSettings.tsx`'s `apply`, `detectServeSettings` and `lockDownNow` writers
  rebuild the whole mobile-host object; none carries `browser_client`.
- `host.rs` `Phone` holds only the device id; the name is in
  `AuthStore::devices()` (`AdminDevice.name`). `files_scope` resolves through
  the per-phone catalog (`catalog(state, phone)`), so a phone outside a
  project's device list gets `project_not_found`.
- The drawer has no "pill" class. Its buttons: `files-close`, `files-share`,
  `.files-trail` crumbs; the ＋ sheet's *Send a file* is `.new-tab-file`; the sibling upload rows are `ProjectInbox.tsx`'s
  `.inbox-upload` (with `pickPhoneFiles`, `ANY_FILE_ACCEPT`, the
  `MAX_INBOX_FILE` pre-check, `postFile` in `api.ts`). Uploads there go via
  `fetch` (`postFile`) — no progress events.
- The drawer opens by a left→right swipe on the project screen or the
  header's ☰ (no 📁 since 2026-09-28). Its note `mobile.files.readOnly`
  ("nothing here can be changed") becomes false once Upload shows.
- Mobile tests live in `src/__tests__/mobile/` (`MobileProjectFiles.test.tsx`,
  `MobileLocalModelsGate.test.tsx` for a settings gate — there is no
  `MobileSettings.test.tsx`); the indicator's in
  `src/__tests__/root/InboxIndicator.test.tsx`. Phone strings use the shared
  `src/lib/i18n.ts` (+ `src/lib/i18nDicts/{de,fr,es,it}.ts`, which carry the
  sibling `mobile.files.*` keys).
- Poison-safe locks: `app_core::sync::LockExt` (`lock_ok()`). Private atomic
  writes in the sidecar: `mobile_control::store::{ensure_private_dir,
  write_bytes_atomic}`. Desktop id → folder: `services::remote::project_directory`
  (+ `remote::remote_target_for` to refuse a project that became remote).

## Steps

### Step 1 — service (`services/mobile_control/uploads.rs`, new)

- `files.rs`: widen `ProjectDir::open` to `pub(super)` (Unix) and
  `pub(in crate::services::mobile_control)` (Windows, `files_windows.rs`).
  Update the module doc ("Nothing here writes") to point at `uploads.rs`.
- `inbox.rs`: factor `store_at`'s name loop into
  `pub(super) fn create_unique(dir: &ProjectDir, base: &str, bytes: &[u8]) ->
  io::Result<String>` (stem cut to fit 255 bytes with `-1000` + ext, `-2`,
  `-3`… on `AlreadyExists`, remove-on-failed-write, 1 000 tries); `store_at`
  keeps its stamp + total cap and calls it. `safe_name`: a Windows device
  stem (`CON PRN AUX NUL COM1-9 LPT1-9`, any case, any extension) gets a `_`
  appended to the stem on every OS (inbox benefits too); test it.
- `uploads.rs`:
  - `uploads_open(state_dir) -> bool`: `files::files_open` **and**
    `tabtivity_mobile_host.project_uploads == true`, read per call.
  - `accepts(rel_dir) -> bool`: no segment starts with `.` (`rel_dir` already
    passed `files::unseal`'s `valid_rel`; `""` = project root, accepted).
  - `store(state_dir, root, raw_id, rel_dir, raw_name, bytes, phone:
    Option<&str>) -> Result<Landed, UploadError>`: empty / >
    `inbox::MAX_INBOX_FILE` / `!accepts` checks; `ProjectDir::open(root,
    rel_dir)` (any failure → `upload_refused` for a bad folder,
    `project_unavailable` for a gone root); under a process-wide `static
    Mutex<()>` (`lock_ok()`): rolling cap = sum of `size` of this project's
    log lines with `at` within 24 h — the log alone, **no** disk check (undone
    uploads still count; nothing to hash) — then `create_unique(dir,
    &safe_name(raw_name), bytes)`, sha256 of `bytes` (`sha2`), log append.
    `Landed { id, name, rel, size }`.
  - Log: the decision-7 path (see open question), dir via
    `store::ensure_private_dir`; one line per landed file, written with a
    single `write_all` on an `O_APPEND` handle; `phone` bounded to 64 chars;
    `id` = 16 random bytes base64url (`auth::random_bytes`). Compaction under
    the same mutex when the first line is older than 7 days: rewrite the kept
    lines with `store::write_bytes_atomic(.., 0o600)`. Unparseable lines are
    skipped (and dropped at compaction).
  - `fn intact(root, rel, size, sha) -> bool`: `ProjectDir::open(parent)` +
    `open_file(leaf)` (regular, no link anywhere) + size + sha256 through
    that same handle.
  - `undo(state_dir, root, raw_id, rel) -> Result<(), UploadError>`: the
    newest record with this `raw_id` + `rel` whose file is `intact` (always
    re-hashed), then `remove_file(leaf)` on the held parent; else
    `file_not_found`. The log is not touched.
  - `recent(state_dir, within, root_of: impl Fn(&str) -> Option<PathBuf>) ->
    Vec<Record>`: records within `within`, newest first, filtered by
    `intact`. The desktop polls this every 10 s, so keep a process-local cache
    `(raw_id, rel) → (size, mtime, ok)` and re-hash only when size or mtime
    changed (decision 7's sha check, without re-reading up to 1 GiB per poll).
  - `UploadError::code()`: `uploads_off`, `upload_refused`, `empty_file`,
    `file_too_large`, `uploads_full`, `project_unavailable`,
    `file_not_found`, `write_failed`.
- Register `pub mod uploads;` in `services/mobile_control/mod.rs`.
- Tests in `uploads.rs` (tempdirs, `/`-joined rels, no absolute literals):
  lands with original name; clash → `-2`; leading-dot and `CON.txt` names
  sanitized; dot segment refused (`.github`, nested `docs/.hidden`); empty +
  oversized refused; cap (log pre-filled near 1 GiB → `uploads_full`, other
  project unaffected, lines > 24 h ignored); undo of a logged file works, of
  an edited / unlogged / other project's file refused; `recent` drops a
  moved or edited file; stale (> 7 d) lines dropped at compaction; garbage
  line skipped. Link cases twice: `#[cfg(unix)]` symlinked folder + symlinked
  leaf (undo must not delete through it), `#[cfg(windows)]` junction twins
  (copy `files.rs` tests' `junction` helper).

### Step 2 — routes + desktop commands (backend)

- `host.rs` route table (next to `…/files/search`, `~l. 6188`):
  `/api/v1/projects/{project_id}/files/upload` →
  `delete(project_files_upload_undo).merge(post(project_files_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE)))`
  (the inbox routes' shape).
- `project_files_upload` (`?dir=<token>&name=`, `InboxQuery`-style name +
  optional `dir`; body `Bytes`): `authenticate` → `exact_origin`
  (`invalid_origin`) → `files_scope` → `uploads::uploads_open`
  (`uploads_off`) → `files_rel` (no `dir` = root) → phone name via
  `state.auth.lock_ok().devices()` by `phone.device_id()` → `spawn_blocking`
  `uploads::store` → `201 { file: files::entry(&root, &landed.rel, &key,
  &raw_id) }` (`None` → `file_not_found`). Status per code: `uploads_off`
  404, `upload_refused` 403, `empty_file` 400, `file_too_large` 413,
  `uploads_full` 507, `project_unavailable` 409, `file_not_found` 404,
  `write_failed` 500.
- `project_files_upload_undo` (`?f=<token>`): same guards (origin too) →
  `files_rel` → `spawn_blocking` `uploads::undo` → `204`.
- `project_files_list`: answer `listing` plus `"uploads":
  uploads_open(state_dir) && accepts(&rel)` (merged into the JSON in the
  handler; `files::Listing` stays as is). Fix `project_files_raw`'s doc
  ("there is no write route").
- Host tests (module at `~l. 6617`, beside
  `the_file_browser_is_off_by_default_and_reads_by_sealed_token_only`):
  files off → `files_off`; files on + uploads off → `uploads_off` and listing
  `uploads: false`; wrong origin → `invalid_origin`; happy path (201, entry,
  file on disk, listing `uploads: true`, log line with the phone's name);
  `.github` folder token → `upload_refused` + listing `uploads: false`; undo
  → 204 and gone; a second undo → `file_not_found`. Add both new routes to
  the per-phone scoping test's `routes` list (`~l. 11040`).
- `commands/mobile_control.rs` (beside `global_inbox_*`):
  `phone_uploads_list() -> Vec<PhoneUpload>` (async, `spawn_blocking`;
  `uploads::recent(state_dir, 24 h, …)` with roots from
  `remote::project_directory`, skipping ids `remote::remote_target_for`
  calls remote; project names from `commands::projects::get_projects()`;
  row = `{ id, project_name, rel, size, at, phone }` — no raw id, no root) and
  `phone_upload_undo(id: String) -> Result<(), String>` (record by id → same
  root resolution → `uploads::undo`; error = the code). Both
  `#[cfg_attr(feature = "desktop", tauri::command)]`, no `AppHandle`.
- `services/command_class.rs`: both `Core` (as `global_inbox_list/delete`);
  regenerate `src/lib/transport/commandClasses.ts`
  (`UPDATE_COMMAND_CLASSES=1 cargo test -p tabtivity --lib --
  the_generated_command_classes_ts_is_current`); register in `lib.rs`
  `generate_handler!` next to `global_inbox_delete` (`~l. 1591`).
- Gate the daemon build too (`cargo test -p tabtivity --no-default-features
  --lib …`, `cargo clippy … --no-default-features`).

### Step 3 — desktop: settings switch + indicator section

- `src-tauri/src/schema/settings.rs` `AppMobileHostSettings`: add
  `project_uploads: Option<bool>` and the missing `browser_client:
  Option<bool>` (sibling bug), plus `#[serde(flatten)] extra: HashMap<String,
  Value>` so a key a newer build writes survives a patch. Round-trip test
  like `mobile_host_local_models_switch_round_trips` (both keys + an unknown
  one survive `merge_settings_patch`).
- `src/types/index.ts`: `project_uploads?: boolean` with doc.
- `src/components/mobile/MobileSettings.tsx`: `"project_uploads"` in
  `setMailGate`'s union (default off → stores `on || undefined`); carry
  `project_uploads` in **all three** whole-object writers (`apply`,
  `detectServeSettings`, `lockDownNow`) and `browser_client` in `apply` and
  `detectServeSettings` (sibling bug;
  lockdown leaves it out on purpose — it closes browser access). A
  `ToggleRow` under *Project files*, `disabled={busy || !stored?.project_files}`,
  label with `<UntestedTag id="mobile.files.upload" />`, help as a
  `settings-help` paragraph (no `Hint` component exists there).
- `src/components/header/InboxIndicator.tsx`: a second `load` for
  `phone_uploads_list` in the same `usePoll`; *Added to projects* section
  (row: project name · `rel`, `formatBytes(size)`, age, phone if any;
  **Undo** armed-then-confirm like the delete, `armed` keyed `upload:<id>`;
  **Keep** hides it via `localStorage[storageKey("inbox.keptUploads")]`, ids
  pruned to the listed ones, try/catch); `<UntestedTag
  id="desktop.inbox.phoneUploads" />` on the section label. Renders while
  global files or un-kept uploads exist; badge counts both; the button's
  click reveals the global folder only when it has files, else opens the
  menu. Undo failure (`file_not_found`) re-lists and shows the row gone.
- `src/lib/untested.ts`: rows `mobile.files.upload` and
  `desktop.inbox.phoneUploads`.
- `src/lib/i18n.ts` (+ `i18nDicts/*` where the siblings have the key):
  settings label/help, section title, Undo/Keep/confirm, age.
- Tests: `src/__tests__/mobile/MobileProjectUploadsGate.test.tsx` (modelled
  on `MobileLocalModelsGate.test.tsx`: disabled while files off, stores only
  `true`, survives apply/detect/lockdown); `InboxIndicator.test.tsx`: the
  existing mocks answer `phone_uploads_list` with `[]` (else the empty test
  breaks), uploads alone render the button, Undo only on the second click
  calls `phone_upload_undo`, Keep hides across a remount.

### Step 4 — phone UI (`mobile-web/`)

- `mobile-web/src/api.ts`: `ProjectFileListing.uploads?: boolean` (an older
  host omits it); `uploadProjectFile(projectId, dirToken | undefined, file,
  name): Promise<ProjectFileEntry>` via `postFile`
  (`…/files/upload?name=…[&dir=…]`, `malformed_response` without `file`);
  `undoProjectUpload(projectId, token)` via `api(…, { method: "DELETE" })`.
- `mobile-web/src/components/ProjectFiles.tsx`: when `!searching &&
  listing?.uploads`, an **Upload here** button under the trail styled as an
  existing class (the ＋ sheet's *Send a file* button, `.new-tab-file` in
  `NewTabSheet.tsx`, with its upload glyph), a hidden `ANY_FILE_ACCEPT` `multiple` input opened through
  `pickPhoneFiles`; rows as `ProjectInbox.tsx`'s `.inbox-upload`
  (sending / landed / failed, `MAX_INBOX_FILE` pre-check). If the hook would
  be a third near-copy of `useProjectInbox`/`SendToDesktop`, factor the
  shared pick-and-rows part instead of copying. Files go one after another;
  each landing re-lists `here.token` and marks the new entry; a landed row
  offers **Undo** (`undoProjectUpload` with the answered token) until the
  trail changes. Codes → `mobile.files.upload.*` keys (`uploads_off`,
  `upload_refused`, `uploads_full`, `file_too_large`, `empty_file`,
  `project_unavailable`, `timeout`, `offline`, fallback). The note shows a
  new `mobile.files.addOnly` instead of `mobile.files.readOnly` while
  `listing.uploads`. Add `isUntested("mobile.files.upload")` to the head's
  untested condition.
- i18n keys in `src/lib/i18n.ts` (+ `i18nDicts/*`).
- Tests in `src/__tests__/mobile/MobileProjectFiles.test.tsx`: no button
  without `uploads`; upload posts to the right URL with `dir`, re-lists,
  Undo sends the DELETE; error code → text; too-large refused before any
  fetch. Then `npm run mobile:bundle`.

### Step 5 — docs + QA entry

- `docs/help/mobile.md` (Upload here, the switch, Undo on both sides),
  `DOCUMENTATION.md` (`rg -n "Project files on the phone"`, `~l. 464`),
  `docs/context/mobile_access.md` one paragraph (why add-only, why
  dot-folders refused), `docs/threat_model.md` row *Phone project files and
  PDFs* (`~l. 161`: the write route, its switch, add-only, dot rule).
- File maps: `docs/filemap_backend.md` `mobile_control/` row (`files.rs`
  "read-only", `uploads.rs`), `docs/filemap_frontend.md` rows of
  `ProjectFiles.tsx` / `InboxIndicator.tsx` if they describe behaviour.
- `todo/group-h-crossplatform.md` beside 31bo (`~l. 3582`): new entry with
  the untested ids and a 🖐️ box with the four platform ✅/❌ pairs.

## Agent steps

One agent per row, in order (B needs A; C and D need B's commands/routes;
C and D both add i18n keys, so they run one after the other).

| Agent | Plan step | Main files |
|---|---|---|
| A | 1 | `services/mobile_control/uploads.rs` (new), `inbox.rs`, `files.rs`, `files_windows.rs`, `mod.rs` |
| B | 2 | `host.rs`, `commands/mobile_control.rs`, `command_class.rs`, `lib.rs`, `commandClasses.ts` |
| C | 3 | `schema/settings.rs`, `MobileSettings.tsx`, `InboxIndicator.tsx`, `types/index.ts`, `untested.ts`, `i18n.ts` |
| D | 4 | `mobile-web/src/{api.ts,components/ProjectFiles.tsx}`, `i18n.ts`, phone tests |
| E | 5 | docs, file maps, todo |

## Verification

Gates per AGENTS.md (`scripts/gates.sh`, incl. the daemon-build test/clippy
and, since `files_windows.rs` and cfg'd tests change, the Windows msvc
clippy/check cross-check); `npm run backend:stale` after landing (the routes
need the sidecar updated, the PWA `npm run mobile:bundle`). Not run live —
click-through for the user:

1. Desktop: Settings → Mobile → *Project files on the phone* on, then *Phone
   may add files to projects* on (greyed out while the first is off). Reload
   settings: both still on.
2. Phone: a project → swipe in the files drawer (or ☰) → open `docs/` (or
   any folder) → **Upload here** → pick a PDF → it lands under its own name;
   the desktop tree shows it; the header inbox lists it under *Added to
   projects*.
3. Upload the same file again → `name-2.pdf`.
4. Open `.github` (listed — only `.git`, `.tabtivity`, `.env*` are hidden)
   → no Upload button, note still says read-only.
5. Phone **Undo** → file gone. Upload again, edit it on the desktop, then
   desktop **Undo** → refused, file kept. **Keep** on another row → it stays
   hidden after a restart.
6. Turn the switch off → the button disappears on the next listing; a
   stale upload is refused with "uploads are off".

## Resolved questions

1. **Log location (decision 7)** — `<state_dir>/mobile-control/phone-uploads.jsonl`
   (the sidecar's private `0700` state dir, `config.control_dir`); decided by
   the main agent 2026-10-12 as a detail, not a design change.
