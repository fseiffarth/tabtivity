# Mail client in Tabtivity — Plan A (host integration / architecture)

Scope: how a native mail client plugs into Tabtivity. IMAP/SMTP library choice and
HTML sanitization are Plan B's (`docs/mail_client_plan_b.md`); this plan owns the
tab surface, the backend surface, the sandbox/capability boundary, persistence,
credentials, and the two-workstream split.

> **Superseded in one respect: there is no mail tab.** This plan specifies the
> client as a tab (§ steps 8–10, decision 9) with the header overlay added
> afterwards as a second surface. Both were built, and the tab was then retired:
> the mail store is global, so a tab could only ever show the same mailbox the
> overlay does while still belonging to a scope you switch away from. What
> survives is the overlay (`MailOverlayHost` → `MailPane`) behind the header's ✉
> button, gated by `mail_client` alone — the `mail_global_app` sub-toggle went
> with the tab. `MAIL_TAB_CMD` remains only as a retirement marker
> (`RETIRED_TAB_CMDS`), so a layout persisted before the removal drops its mail
> tab instead of restoring it as a terminal. **Everything else in this plan —
> the backend surface, the path-free IPC boundary, persistence, credentials —
> is unchanged and still binding.**

## 0. Constraints (restated, binding)

- **Never launch Tabtivity to verify.** The only gates an agent has are
  `npx tsc --noEmit` and `cargo test --manifest-path src-tauri/Cargo.toml`.
  Everything else is a request to the user.
- Every new/unverified surface carries `<UntestedTag />`
  (`src/components/common/UntestedTag.tsx`); inside a `.context-menu` button also
  add `className="untested"`.
- All menus/dialogs use the canonical scheme: `.context-menu`/`.tab-new-menu`
  popover (accent top rail + accent wash, `src/styles/themes.css:8805-8836`) and
  `.modal-backdrop > .settings-dialog` with an accent `.settings-title-row` +
  divider. **Portaled dialogs must set an explicit `color`** — `body` carries
  none, so inherited color renders black
  (`src/components/calendar/EventDialog.tsx:129-134` is the reference).
- No institution/lab hostnames, no provider presets that leak affiliation.
  `gmail.com`/`outlook.com` generic presets only. Repo is public;
  `scripts/privacy-check.sh` before push.
- Every new user-facing string goes through `src/lib/i18n.ts` in all five
  languages (en is source of truth; others fall back).

## 1. Tab/subwindow surface

**Best template: the `calendar` tab, not a viewer tab.** The viewer tabs
(table/notebook/diff/sqlite/media/gif) are all `kind: "embed"` with a
`viewer: InternalViewer` discriminator — they are *file*-shaped
(`TabEntry.embedPath` drives them). Mail is a self-contained, global-store,
non-file app pane in every scope, which is exactly what `calendar` is: its own
`TabKind`, its own sentinel `cmd`, a global store, its own backend module and its
own JSON file. Copy `calendar` end to end.

Exact edit sites (all frontend; the Rust `TabEntry` needs **no** change —
`schema/project.rs:56-69` carries `extra: HashMap<String, Value>` flattened, so
`kind` rides in `extra`):

| # | File:line | Change |
|---|---|---|
| 1 | `src/stores/tabs.ts:46-57` | Add `\| "mail"` to the `TabKind` union. |
| 2 | `src/stores/tabs.ts:164` | Add `export const MAIL_TAB_CMD = "__tabtivity_mail__";` beside `CALENDAR_TAB_CMD`, with the same doc-comment shape (why it carries no PTY). |
| 3 | `src/stores/tabs.ts:3677-3687` `cmdToKind` | `if (cmd === MAIL_TAB_CMD) return "mail";` — this is what recovers the kind from a bare persisted `cmd` on restore. |
| 4 | `src/stores/tabs.ts:3702-3714` `isRestorableKind` | Add `kind === "mail"`. Policy fit: shell/files/network/monitor/diskusage/calendar always restore; agent tabs restore only when resumable (`isResumableAgentTab`) and embeds only when in-app viewers. Mail has **no live process and no session to lose** — it re-renders from its own store — so it belongs in the always-restore set. It must *not* auto-sync on restore (see §2 cancel/poll rules). |
| 5 | `src/stores/tabs.ts:3718-3720` `isPtyTabKind` | **No change** — mail must never enter spawn/kill/activity paths. |
| 6 | `src/components/tabs/TabPane.tsx:87-138` | Add `case "mail": return <MailPane visible={visible} ownsTabs={ownsTabs} />;` next to the `calendar` case at line 90-91. This one switch is shared by the main window (`CenterPanel.tsx:1106`) and every popout (`DetachedCenterPanel.tsx:1441`), so the pane lands in both at once — do not add a second switch. |
| 7 | `src/components/tabs/newTabItems.ts:85-97` | `TAB_ACCENT` is `Record<TabKind, string>` → **tsc will fail until you add `mail`**. Use `"var(--info, #4aa3df)"` or `var(--accent-secondary)`. |
| 8 | `src/components/tabs/TabHoverCard.tsx:23-35` | `KIND_LABEL_KEY` is `Record<TabKind, TranslationKey>` → also compile-enforced; add `mail: "newTabMenu.mail"`. |
| 9 | `src/components/tabs/TabBar.tsx:509-519` | Add `handleAddMail` modeled on `handleAddCalendar`: `focusGroup(groupId)` then **`ensureTab`** (singleton per scope — the store is global, so a second mail tab in one scope shows the same thing) with `{ label: t("newTabMenu.mail"), cmd: MAIL_TAB_CMD, cwd: projectCwd, kind: "mail" }` and matcher `(tab) => tab.kind === "mail"`. |
| 10 | `src/components/tabs/TabBar.tsx:1389-1398` | Add the menu group/entry beside the Calendar group (`dot: "✉"`, `color: TAB_ACCENT.mail`, plus `<UntestedTag />`). |
| 11 | `src/components/tabs/NewTabMenu.tsx:299-314` | The **detached** window's add menu — same entry, via `pickFixed({...})`. Missing this is the classic "works in main window, dead in popout" bug. |
| 12 | `src/lib/i18n.ts` | `newTabMenu.mail`, `tabKind.mail`, and the whole `mail.*` key block, ×5 languages. |
| 13 | `src/styles/themes.css` | A `.mail-*` block (list rows, message header, compose form), styled from `--text-primary` / `--bg-panel` / `--accent`. |
| 14 | `src/__tests__/TabPersistFilter.test.ts` | Add a case locking `isRestorableKind("mail") === true` (it is the only automated proof the tab survives a restart). |

Persistence path, unchanged and free: `saveLayout`/`persistScope` filter on
`isRestorableTab` and `pruneSavedTree`, write `SavedTabEntry`
(`src/stores/tabs.ts:485-519`) into `project.json`'s `tab_layout`/`tab_groups`
via `services::terminal_service::save_tab_layout`
(`src-tauri/src/services/terminal_service.rs:19`), and restore reads it back at
`:110`. A mail tab needs **no new `SavedTabEntry` field** — its state lives in
the global store, exactly as calendar's does. (If you later want a per-tab
"selected folder", add it as an optional `folder`-style field on both `TabEntry`
and `SavedTabEntry` — do not smuggle it into `viewerState`.)

Optional, later: a `mail` lesson in `src/lib/lessons.ts:451`-style catalog (adds
a required entry to `src/__tests__/Lessons.test.ts:21` id list — keep them in
step or the test fails).

## 2. Backend surface

New modules, following the existing seams:

- `src-tauri/src/commands/mail.rs` — thin `#[tauri::command]` wrappers.
  Registered in `src-tauri/src/commands/mod.rs` (alphabetical, between
  `local_loss` and `monitor`).
- `src-tauri/src/services/mail_store.rs` — `AppHandle`-free, unit-testable: the
  SQLite index/blob store, factored on a `&Path` so tests drive a tempdir (this
  is exactly what `commands/calendar.rs:9-11` does and why its logic is
  testable).
- `src-tauri/src/services/mail_engine.rs` — Plan B's IMAP/SMTP/MIME work lands
  here behind a trait; `AppHandle`-free too.
- `src-tauri/src/schema/mail.rs` — serde structs for `accounts.json`; export from
  `src-tauri/src/schema/mod.rs`.

Registration: add the module to `commands/mod.rs` + `services/mod.rs` +
`schema/mod.rs`, add `.manage(commands::mail::new_state())` next to
`.manage(disk_scans)` (`src-tauri/src/lib.rs:466`), and append the
`commands::mail::*` list to `generate_handler!` (`lib.rs:578`) right after the
calendar block (`lib.rs:659-671`).

**Managed state** — `MailState = Arc<Mutex<MailRuntime>>` (mirrors
`DuScanState`/`RegistryState`):

- `Mutex<rusqlite::Connection>` opened lazily on the mail DB (rusqlite **is
  already a dependency**, `Cargo.toml`, `rusqlite = { version = "0.40.1",
  features = ["bundled"] }`, used read-only by `commands/sqlite.rs`; mail is the
  first *writer*, so it owns its own connection and never touches the viewer's).
- `HashMap<account_id, String>` of **session-only** passwords (never serialized,
  dropped at exit) — the analogue of `stashRemotePassword`.
- Live IMAP sessions keyed by account, torn down on `RunEvent::Exit` alongside
  the remote pool.
- `HashMap<account_id, Arc<AtomicBool>>` cancel flags, exactly the
  `commands/disk_usage.rs:110-152` pattern.

**The freeze hazard — the single most important backend rule.** A synchronous
`#[tauri::command]` body runs on the main thread and freezes the whole WebView.
This has bitten the project twice already and both fixes are in-tree:
`commands/tex.rs:317-326` ("a sync command runs on the main thread, so every
Recompile used to freeze the whole webview for up to the 600 s run timeout" →
`spawn_blocking`), and the remote side, where SFTP/git probes on a dead SSH
session froze the window so hard that the frontend now carries a permanent gate
(`useRemoteBlocked`, `src/components/files/ProjectFilesPane.tsx:34-44`: "Git/
endings/SFTP probes are SYNCHRONOUS Tauri commands (main thread), so dispatching
one at a dead session freezes the window"). Network mail I/O is *worse* than
either — an unreachable IMAP server hangs for the TCP timeout.

Therefore, non-negotiable:

1. **Every `mail_*` command is `pub async fn`.** No exceptions, not even
   `mail_accounts_list` (an async command that returns instantly costs nothing; a
   sync one is a landmine the day it grows a keyring read).
2. All blocking work (sockets, TLS handshake, rusqlite, keyring) goes through
   `tokio::task::spawn_blocking` — the shape at `commands/disk_usage.rs:110`,
   `commands/hpc_ws.rs:442`, `commands/slurm.rs:210-216`.
3. Every network command takes a bounded timeout and is cancellable
   (`mail_sync_cancel`), and long syncs report via `app.emit("mail:sync", …)`
   progress events rather than one long return
   (`commands/disk_usage.rs:45-52`).
4. Keyring reads use the existing `read_timed` path only — never a raw
   `keyring::Entry` (see §5).
5. No mail command is ever dispatched from a launch/restore path. A restored mail
   tab renders from the local store and shows a **Check mail** button; it does
   not connect.

## 3. Sandbox strategy — the core question

The requirement is: *only explicitly selected files cross the boundary*. Judge
the three options on security delivered, cross-platform cost, and fit with what
Tabtivity has.

### (a) Reuse/extend the Docker project-container machinery

`services/sandbox.rs` is genuinely good containment: identical-path bind mounts,
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`, `--pids-limit`,
spec-fingerprint lifecycle, orphan sweep. But every one of its design axes is
wrong for mail:

- **Wrong scope and lifetime.** The container is *per project*, keyed
  `tabtivity-<project-id>`, created on project activation and destroyed on
  deactivate/exit (`docs/context/docker_containers.md`). Mail is a machine-level
  feature like the calendar, the VPN tunnel and global machines — it has no
  project. You would either invent a fake project (ugly, and it inherits
  project-switch teardown, so mail dies when the user switches projects) or add a
  second, differently-shaped container lifecycle, which is new machinery, not
  reuse.
- **Wrong platform coverage.** Local projects only, **hidden on Windows**,
  refused at spawn (`services/mod.rs:17-24`). Tabtivity ships deb/appimage/nsis. A
  mail client that only exists on Linux-with-Docker is not a feature of the app.
- **It requires Docker installed.** Optional for a per-project sandbox toggle;
  unacceptable as a hard prerequisite for reading mail.
- **The boundary it draws is the wrong one anyway.** The mail engine needs the OS
  keychain (D-Bus/Secret Service), the ability to raise native file dialogs, and
  an IPC channel to the WebView. Punching those three holes through a container
  is most of the container's value spent, and the remaining risk (a malicious
  message exploiting the parser) is bounded by the *process*, not by the mount
  set — which is what (b)/(c) address more cheaply.

Verdict: **no.** Not reuse; a parallel implementation wearing reuse's clothes.

### (b) OS-level sandbox for a separate helper process

Real security value: bubblewrap or a `landlock` ruleset + `seccomp` filter around
a helper that holds the socket and the MIME parser bounds the blast radius of a
parser bug to a process with no filesystem beyond
`~/.local/share/tabtivity/mail/`. That is the textbook-correct answer for
"untrusted bytes from the internet".

Costs, concretely for this repo:

- **Nothing in-tree today.** No `bwrap`, `landlock`, or `seccomp` reference
  anywhere in `src-tauri/` — this is a from-scratch subsystem plus new crates plus
  an IPC protocol plus a second binary (or a `--mail-helper` argv mode on the same
  binary) plus packaging changes in three bundle targets.
- **No Windows/macOS story that's worth the name.** Windows would be
  AppContainer/job objects (a large, separate project); macOS would be App
  Sandbox entitlements, which conflict with how the app is bundled today.
  Realistically Linux gets sandboxed and the other two get nothing — so the
  *guarantee* is per-platform, and the UI can't honestly promise it.
- **The bwrap variant is fragile**: not installed everywhere, and unusable inside
  some container/Flatpak environments; you need a graceful degrade path, which
  means the code must work unsandboxed anyway.

Verdict: **not Phase 1 — but design for it.** It is the right eventual answer on
Linux.

### (c) In-process isolation with a hard capability boundary — **RECOMMENDED**

Three layers, all of which are already the way this codebase works:

1. **No ambient filesystem, enforced at the command signature.** This is the core
   move and it is what actually satisfies the requirement. **Not one `mail_*`
   command takes a filesystem path as a parameter.** Everything the mail
   subsystem reads or writes on its own is under `mail_dir()` =
   `storage::state_dir().join("mail")`, resolved internally, never from the
   frontend. Files cross only through two commands that *raise the OS picker
   inside Rust* (below). Consequences worth stating: an attacker who fully
   controls the message bytes, the HTML, and the JS in the mail pane still has no
   reachable IPC verb that names a path — there is nothing to path-traverse,
   because there is no path argument to traverse.
2. **A rendering surface that cannot fetch.** The app-level CSP already forbids
   remote loads (`src-tauri/tauri.conf.json:29` — `default-src 'self'; img-src
   'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost`). The message
   body renders in an `<iframe sandbox srcdoc=…>` with **no `allow-scripts` and no
   `allow-same-origin`**, plus its own `<meta http-equiv="Content-Security-Policy"
   content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">`.
   Remote images are off by default; "Load images" fetches through the backend (no
   cookies, no auth headers) and inlines as `data:` URLs, so the tracker never
   sees the user's IP unless they clicked. Sanitization itself is Plan B's.
3. **A process-shaped seam, ready for (b).** All mail work lives behind one
   `MailEngine` trait in `services/mail_engine.rs` with an `AppHandle`-free,
   path-free API that speaks *messages*, not files, and touches disk only through
   a `MailStore` handle. Moving that behind a pipe to a landlocked helper later is
   a transport swap, not a rewrite — nothing above the trait learns about it. Add
   `MailEngine::InProcess` now, `MailEngine::Helper` in Phase 5, Linux-only,
   behind an experimental flag.

### The file-crossing contract (both directions)

Both directions go through a **backend-raised** native dialog, using
`tauri_plugin_dialog`'s Rust API (`DialogExt`; the plugin is already initialised
at `src-tauri/src/lib.rs:970`, it is simply not yet used from Rust). Use the
callback API bridged to a `tokio::sync::oneshot` inside the async command — never
`blocking_pick_file` on the main thread.

**OUT (attachment → disk):** `mail_attachment_save(message_id, part_id) ->
Option<String>`. The backend decodes the part into memory, raises the OS **save**
dialog with the sanitized filename pre-filled, and writes the bytes to whatever
single path the user chose. Returns the chosen path (for a toast) or `None` on
cancel. The frontend never supplies a destination; the mail engine never
enumerates the filesystem; a cancelled dialog writes nothing.

**IN (disk → attachment):** `mail_attach_pick(draft_id) ->
Vec<StagedAttachment>`. The backend raises the OS **open** dialog (multi-select),
*copies* the chosen files into `mail_dir()/outbox/<draft-id>/` and returns opaque
`staged_id`s with filename/mime/size. The draft references staged ids only. After
that call the mail subsystem has no reason and no verb to read anything outside
its own directory, and a compose window cannot re-read the original file later
(the copy is the boundary).

**Explicitly refused** (each of these would be an ambient hole): no "Open
attachment with system app" (that is arbitrary-file-write + exec through
`commands::apps::open_file`); no drag-out of attachments via `tauri-plugin-drag`;
no `mail_*` command that accepts a path, a glob, or a project directory; no
writing attachments into the active project's tree "for convenience". In-tab
preview of an attachment is fine and stays inside the boundary —
`mail_attachment_preview` returns bounded bytes over IPC and the pane renders them
with the existing viewers; nothing touches the filesystem.

A cheap, real regression gate given that only `cargo test` runs: a unit test in
`commands/mail.rs` that `include_str!`s its own source and asserts no
`#[tauri::command]` function signature in the file contains a
`path`/`dest`/`dir`/`file` `String` parameter. That is a mechanically-checkable
statement of the whole boundary, and it fails loudly the first time someone "just
adds a path here".

## 4. Persistence + settings

Everything global, under the existing `~/.local/share/tabtivity/` layout
(`storage::state_dir()`), **never inside a project** — mail is machine-level like
`calendar.json`, `boxes.json`, the VPN configs and the global machines:

```
~/.local/share/tabtivity/mail/
  accounts.json          # NO secrets: label, address, imap/smtp host+port+user+security,
                         # auth kind, save_password flag, signature, check interval
  mail.db                # SQLite (rusqlite, already a bundled dependency)
  blobs/<sha256>         # cached raw parts/bodies above an inline threshold
  outbox/<draft-id>/     # staged outgoing attachments (copies made by mail_attach_pick)
```

- **`accounts.json`** through the existing
  `storage::read_json`/`write_json_atomic` helpers and a
  `schema::mail::MailAccounts` struct with a `#[serde(flatten)] extra` catch-all,
  exactly like `schema/calendar.rs` — that catch-all is what lets a newer field
  survive an older build.
- **`mail.db` (SQLite)** for folders, the header index, flags, message↔part
  metadata and the send queue. Justification: rusqlite is *already* a dependency
  with `features = ["bundled"]` (no new build burden), and a header index needs
  sorted paging + full-text-ish search over tens of thousands of rows, which a
  JSON blob rewritten atomically on every flag change cannot do. Bodies over
  ~256 KB go to `blobs/` content-addressed; small ones live in the DB. Schema
  versioned in a `meta` table with forward-only migrations.
- **`settings.json`** gets only *preferences*, mirroring the `calendar_*` block
  (`src-tauri/src/schema/settings.rs:39-47` + `src/types/index.ts:110-135`):
  `mail_enabled`, `mail_default_account`, `mail_check_interval_min`,
  `mail_show_remote_images` (default false), `mail_notify_new` (default true,
  inbox only). Five stable knobs justify real Rust fields; anything experimental
  rides the settings `extra` catch-all the way `custom_agents` does.
- **Never in settings.json:** accounts and anything message-shaped.
  `settings.json` is read and rewritten wholesale by unrelated code paths; a 40 KB
  account list there is a corruption surface.
- Add a **"Clear cached mail"** action (drops `mail.db` message bodies +
  `blobs/`, keeps accounts) — a mail store grows without bound and the user needs
  one button, not a shell.

## 5. Credential handling

Reuse `src-tauri/src/services/remote_credentials.rs` wholesale — do **not** write
a second keychain path. It already solves every hazard mail is about to meet:

- **New account key builder** beside `ssh_account` (`:42`) / `openvpn_account`
  (`:52`): `pub fn mail_account(proto: MailProto, user: &str, host: &str, port:
  u16) -> String` → `"mail:imap:user@host:port"` / `"mail:smtp:…"`, under the same
  `SERVICE = "tabtivity-remote"` (`:22`). Keyed by **server target, not account id**,
  matching the SSH rule — one saved secret per login, whichever dialog saved it.
- **Reads go through `get`** (`:164`), which is `read_timed`-bounded at 4 s
  (`:127`) and asks `cached_keyring_state()` before dispatching, so a locked
  collection is *never* dispatched to. This is the whole locked-keyring lesson: a
  locked collection reads identically to an empty one, and reads used to **hang** —
  the bound turned a freeze into a silence, and the keyutils cache turned most
  reads into a syscall that cannot block. Mail must inherit that, not reinvent it.
- **Writes go through `remember_secret`** (`:458`) and return `RememberOutcome {
  saved, error }` — so `mail_account_upsert` returns `{ account, saved, save_error
  }` and the dialog renders **what the keychain actually did**, with the reason
  inline when it refused. Never `let _ = set(...)`.
- **`false` is unrepresentable.** The frontend passes `remember: true | null` via
  the existing `rememberArg` helper — never `false`. Clearing a saved mail
  password is only ever the explicit "Forget saved password" action
  (`mail_forget_password`). This closes exactly the bug documented in
  `docs/context/remote_credentials.md` §"A connect must never be able to forget":
  a checkbox seeded by an async keyring read, clicked before the read lands,
  deleting the password it just authenticated with.
- **Standing rule honoured: passwords are NOT persisted by default.** "Save
  password" is an opt-in checkbox, **default OFF**. Unsaved means the password
  lives only in `MailState`'s in-memory map for the session. A blank password
  field means "use the saved one", not "authenticate with nothing". The checkbox
  is *pre-ticked* only when the target already has a saved secret (so an untick is
  an explicit delete).
- **Locked keyring UX:** a banner in the mail account list with an **Unlock
  keyring** button wired to the existing `keyring_unlock` command
  (`commands/credentials.rs:37`) — reachable **only from a click**, never from a
  launch or poll path, because those promise not to prompt. A locked keyring must
  degrade to "ask me this session", never to "your account is gone".
- **Never through a PTY.** Mail passwords go straight from `MailState` into the
  IMAP/SMTP client. `credential_paste_to_pty` exists for terminal logins; it has no
  mail analogue and must not grow one.
- **OAuth2** (Phase 4): refresh token = a persisted secret, so it obeys the same
  opt-in, same default OFF; access tokens stay in memory only. Consequence to
  state in the dialog: with persistence off, an OAuth account re-authorizes each
  session. The OAuth loopback listener binds `127.0.0.1` on an ephemeral port with
  a `state` nonce, and is torn down the moment the code arrives.

## 6. Phased implementation — two parallel workstreams

### The contract (write this first, before either workstream starts)

Two files land in one small commit and are then treated as frozen for the phase:

- `src/types/mail.ts` — the TypeScript types below.
- `src-tauri/src/commands/mail.rs` — every command below, present and registered
  in `generate_handler!`, each returning `Err("not implemented".into())` or a
  fixture. This makes the frontend agent unblocked on minute one and makes
  `npx tsc --noEmit` meaningful from the start.

Plus `src/lib/mail.ts` — **the** invoke wrapper module (the convention
`lib/remote/hpc/hpcWorkspace.ts` and `lib/remote/hpc/slurm.ts` follow). No component calls
`invoke("mail_*")` directly; every command has exactly one typed wrapper.

**Command surface (frozen contract).** All `pub async fn`, all
`Result<T, String>`, none takes a path:

```
mail_accounts_list()                                     -> Vec<MailAccount>
mail_account_upsert(account, password: Option<String>,
                    remember: Option<bool>)              -> MailAccountSaved { account, saved, save_error }
mail_account_delete(account_id)                          -> ()
mail_account_test(account, password: Option<String>)     -> MailProbe { imap_ok, smtp_ok, error }
mail_password_state(account_id)                          -> { has_saved: bool, keyring: KeyringState }
mail_forget_password(account_id)                         -> ()
mail_folders(account_id, refresh: bool)                  -> Vec<MailFolder>
mail_sync(account_id, folder_id: Option<String>)         -> MailSyncSummary      # emits "mail:sync"
mail_sync_cancel(account_id)                             -> ()
mail_headers(folder_id, offset, limit, query: Option<String>) -> MailHeaderPage { items, total }
mail_body(message_id, allow_remote: bool)                -> MailBody
mail_flag(message_id, flag: MailFlag, value: bool)       -> ()
mail_move(message_ids: Vec<String>, dest_folder_id)      -> ()
mail_draft_save(draft: MailDraft)                        -> MailDraft
mail_draft_send(draft_id)                                -> MailSendResult { sent_id, error }
mail_attach_pick(draft_id)                               -> Vec<StagedAttachment>   # backend raises OS open dialog
mail_attach_remove(draft_id, staged_id)                  -> ()
mail_attachment_save(message_id, part_id)                -> Option<String>          # backend raises OS save dialog
mail_attachment_preview(message_id, part_id)             -> MailPreviewBlob { mime, bytes_b64 }
```

Events: `mail:sync` → `MailSyncEvent { account_id, folder_id?, phase:
"start"|"folder"|"headers"|"done"|"error", new_messages?, error? }`; `mail:new` →
`{ account_id, folder_id, count }` for the notification.

**TypeScript types (frozen contract):**

```ts
export interface MailAddress { name?: string; address: string }
export interface MailServer { host: string; port: number; user: string; security: "tls" | "starttls" | "none" }
export interface MailAccount {
  id: string; label: string; address: string; display_name?: string;
  imap: MailServer; smtp: MailServer;
  auth: "password" | "oauth2"; save_password: boolean;
  signature?: string; check_interval_min?: number;
}
export interface MailFolder { id: string; account_id: string; path: string; name: string;
  kind: "inbox"|"sent"|"drafts"|"trash"|"junk"|"archive"|"other"; unread: number; total: number }
export interface MailHeader { id: string; account_id: string; folder_id: string; uid: number;
  subject: string; from: MailAddress; to: MailAddress[]; cc: MailAddress[]; date: string;
  seen: boolean; flagged: boolean; answered: boolean; has_attachments: boolean; size: number; preview: string }
export interface MailAttachmentMeta { part_id: string; filename: string; mime: string; size: number; inline: boolean }
export interface MailBody { id: string; html?: string; text?: string; remote_refs: number; attachments: MailAttachmentMeta[] }
export interface StagedAttachment { staged_id: string; filename: string; mime: string; size: number }
export interface MailDraft { id: string; account_id: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; body_text: string; body_html?: string; in_reply_to?: string; staged: StagedAttachment[] }
export type MailFlag = "seen" | "flagged" | "answered" | "deleted";
```

### BACKEND workstream

- **B1 (Phase 1)** — module skeleton + registration (`commands/mail.rs`,
  `services/mail_store.rs`, `services/mail_engine.rs`, `schema/mail.rs`,
  `mod.rs`×3, `lib.rs` manage + handler); `mail_dir()`; SQLite schema +
  migrations; `accounts.json` read/write; the `mail_account(…)` keychain key +
  upsert/test/forget wired to `remember_secret`; `mail_folders` / `mail_sync` /
  `mail_headers` / `mail_body` against Plan B's engine. Unit tests on a tempdir
  store (folder upsert, header paging, flag round-trip, `mail_dir` containment)
  and the **no-path-parameter** source test.
- **B2 (Phase 2)** — flags, move/delete, server-side + local search, cancellable
  sync with `mail:sync` events, background poll timer,
  `tauri-plugin-notification` on new inbox mail (the plugin is already a
  dependency, used by calendar alarms).
- **B3 (Phase 3)** — drafts, SMTP send, `mail_attach_pick` /
  `mail_attachment_save` / `mail_attachment_preview` (the Rust-side dialogs). This
  is where the capability boundary is actually built; review it as one commit.
- **B4 (Phase 4)** — multi-account, OAuth2 device/loopback flow, unified inbox
  query.
- **B5 (Phase 5, optional, Linux)** — `MailEngine::Helper`: same binary re-exec'd
  as `--mail-helper`, landlock ruleset limited to `mail_dir()`, seccomp filter,
  length-prefixed CBOR over a pipe. Behind an experimental flag; in-process stays
  the default and the only path on Windows/macOS.

### FRONTEND workstream

- **F1 (Phase 1)** — the tab wiring (§1 rows 1-14); `src/stores/mail.ts`
  (accounts, folders, headers, selection, sync status — global, one store across
  scopes, like `stores/calendar/calendar.ts`); `src/lib/mail.ts` wrappers;
  `components/mail/MailPane.tsx` (three-pane: folder rail / header list / message
  view), `MailList.tsx`, `MailMessageView.tsx` (the sandboxed iframe + "Load
  images" toggle), `MailAccountDialog.tsx` (canonical `.modal-backdrop >
  .settings-dialog` chrome, explicit portal color, `PasswordInput`, the
  default-OFF Save-password row rendered from the shared `useSavedCredential`
  hook, generic gmail/outlook presets only). `<UntestedTag />` on the menu entry
  and the dialog.
- **F2 (Phase 2)** — flag/star/delete/move UI, search box, sync progress from the
  `mail:sync` listener, unread badges, settings sub-panel in `SettingsPanel.tsx`
  beside the calendar block.
- **F3 (Phase 3)** — `MailComposeDialog.tsx`: reply/reply-all/forward, staged
  attachment chips driven by `mail_attach_pick`, download button driven by
  `mail_attachment_save`, in-pane preview via `mail_attachment_preview`.
- **F4 (Phase 4)** — multi-account switcher, unified inbox, per-account accent
  colour, OAuth consent flow UI.

**Phase 1 = a working vertical slice**: add one IMAP account (password not
persisted unless ticked) → the inbox header list loads → click a message → the
body renders in the sandboxed iframe. No send, no attachments in or out, no
background poll. Both workstreams reach that point independently against the
frozen contract, and the only integration step is deleting the fixture returns.

## 7. Risks / open decisions (each with a recommended default)

| # | Decision | Recommended default |
|---|---|---|
| 1 | Sandbox model | **(c)** in-process capability boundary + path-free command surface + sandboxed render iframe, with the `MailEngine` seam so **(b)** is a Phase-5 transport swap on Linux. Reject **(a)**. |
| 2 | Store engine | SQLite (`rusqlite`, already bundled) for index + small bodies; content-addressed `blobs/` for large parts. Not maildir, not JSON. |
| 3 | Where the store lives | Global `~/.local/share/tabtivity/mail/`, never inside a project. |
| 4 | Password persistence | Opt-in checkbox, **default OFF**; unsaved = in-memory for the session; keyed by server target via the existing `remote_credentials`. |
| 5 | OAuth refresh token | Treated as a password (same opt-in, same default OFF) — so OAuth re-authorizes each session when off. Say so in the dialog. |
| 6 | Body download policy | Headers-only sync; bodies on demand, cached with a size cap and a "Clear cached mail" button. |
| 7 | Remote images | Blocked by default; per-message "Load images" that proxies through the backend and inlines as `data:`. Per-sender allowlist deferred. |
| 8 | Open attachment in an external app | **Refused** for the foreseeable future — it is the one ambient write+exec hole. Preview in-tab or save via the picker. |
| 9 | Mail tab singleton per scope? | Yes — `ensureTab`, like calendar (global store). |
| 10 | Restored across restarts? | Yes (`isRestorableKind`), but a restored tab **never auto-connects** — it shows a Check-mail button. |
| 11 | Experimental gate | Ship Phases 1-2 behind an experimental `mail_client` flag (`src/lib/experimental.ts` — off for users, on in debug), flip it on when the user reports it live-verified. |
| 12 | New-mail push | Polling on `mail_check_interval_min` (default 5) in Phase 2; IMAP IDLE deferred (a persistent thread per account is a separate lifecycle problem). |
| 13 | Send failures | Phase 3 sends directly and surfaces a failure state; a retrying outbox queue is Phase 4. |
| 14 | The `mail` global-app role | Leave `GLOBAL_APP_ROLES`' external-mail launcher (`GlobalAppBar.tsx:20`) alone; optionally add "Open Tabtivity Mail" as an extra entry in its menu once the feature is verified. |
| 15 | Untested pills | On the new-tab entry, the account dialog and the compose dialog until the user confirms each; removed per-item, only on their explicit say-so. |

## Critical files for implementation

- `src/stores/tabs.ts` (TabKind:46, MAIL_TAB_CMD beside :164, cmdToKind:3677, isRestorableKind:3702)
- `src/components/tabs/TabPane.tsx` (the one shared kind→pane switch, :87-138)
- `src-tauri/src/lib.rs` (managed state :424-466, generate_handler! :578, calendar block :659-671, dialog plugin :970)
- `src-tauri/src/commands/calendar.rs` (the module template: thin commands over a `&Path`-factored service)
- `src-tauri/src/services/remote_credentials.rs` (mail_account key, get:164, remember_secret:458, read_timed:127)
