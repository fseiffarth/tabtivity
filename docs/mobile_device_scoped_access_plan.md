# Mobile access per phone — plan

When a project (or box) is given Mobile access, the user picks **which paired
phones** see it: *All phones* (today's behaviour, and the default) or *Only
these phones* (a checklist of the paired devices). The sidecar enforces it on
every request, so a phone that is not on the list can neither list nor open the
project, and gets no agent push for it.

Status: plan (2026-10-04), reviewed against the code the same day (see
"Review notes" at the end). Not built.

## 1. Model

- New persisted key beside the existing switch, on the project entry in
  `projects.json` and the box entry in `boxes.json`:
  `tabtivity_mobile_devices: ["<device id>", …]` — brand constant
  `MOBILE_DEVICES_KEY`: a row `MOBILE_DEVICES_KEY / LEGACY_MOBILE_DEVICES_KEY =
  [slug, "_mobile_devices"];` in `brand.rs`'s `names!` table next to
  `MOBILE_ACCESS_KEY` (the macro always mints the `LEGACY_*` twin; it stays
  unused — **not** added to `brand_migration/persisted.rs` `Renames::new` nor
  to `legacy_names_are_exactly_what_older_builds_wrote`, since nothing older
  ever wrote it). `src/lib/brand.ts`: `MOBILE_DEVICES_KEY` only (no legacy
  export). `src/__tests__/shell/BrandMirror.test.ts` "keys the phone
  switches…" gains `MOBILE_DEVICES_KEY === rust.current.MOBILE_DEVICES_KEY`
  (`helpers/rustBrand.ts` parses only `names!` rows — another reason to put it
  in the table rather than as a free `concat!` const).
- Semantics:
  - `tabtivity_mobile_access` absent/false → off (unchanged; the device list
    is ignored and **removed** when access is turned off).
  - access on, `tabtivity_mobile_devices` **absent** → all paired phones,
    including ones paired later (today's behaviour; every existing record
    keeps working unchanged).
  - access on, list **present** → only those device ids. An empty list, one
    whose ids are all revoked, or a **malformed** value (not an array of
    strings) grants no phone (fail closed, *per scope* — see §2.3). The desktop
    UI never writes an empty list (unticking the last phone is refused, or
    offers "turn off" instead).
- Device ids are the sidecar's `auth::Device.id` (`mobile-control/devices.json`):
  `random_id::<20>()` = 27 chars of unpadded base64url. A re-paired phone gets a
  new id and so is *not* in an existing "only these" list — help text says so.
  Revoked ids left in a list are harmless (no session can carry them); they are
  not pruned on revoke (the sidecar must not write `projects.json`).
  **Lock down / Forget all** clears every device: every "only these" scope then
  reaches no phone until re-picked — the UI shows such a row as "No phones"
  (warning tone), not as "All".
- Older builds ignore the new key, so a downgrade shows the project to every
  phone again. Accepted (same class as any new opt-in field); note it in the
  context doc.
- Not a secret boundary for names on the **to-do board**: the board's
  `projects` picker (`MobileBridgeHost.tsx` `todoBoard` → `publicProjects`,
  headless `project_names`) lists *every* registry project, Mobile switch or
  not, and cards carry their project's opaque id. Unchanged here (open
  decision, see Review notes).

## 2. Backend

### 2.1 Commands (`src-tauri/src/commands/projects.rs`, `commands/boxes.rs`)

- `set_project_mobile_access(project_id, enabled, devices: Option<Vec<String>>)`
  and `set_box_mobile_access(box_id, enabled, devices: Option<Vec<String>>)`.
  Payload keys camelCase from the frontend (`projectId`, `boxId`, `enabled`,
  `devices`). `devices: None` → all phones (key removed); `Some(list)` →
  validated (non-empty, ≤ 64 entries, each exactly 27 chars of
  `[A-Za-z0-9_-]`), de-duplicated, written. Recommended: also intersect with
  the ids in `devices.json` (the §2.2 reader) and refuse when nothing is left —
  then stale ids are dropped in one place instead of in the UI. `enabled:
  false` removes both keys. Existing preconditions unchanged (the project one
  is checked twice, before and inside `patch_project_entry` — keep both).
- Projects keep the key in `ProjectEntry.extra` (flattened map; no schema
  change). `save_projects` only copies `status`/`position` from the frontend,
  so a whole-list save cannot erase the list — verified.
- Return value: the project's/box's new access state — keep the current
  return shapes compatible, adding the stored list (`ProjectBox` already
  round-trips; for projects return `{ enabled, devices }` or keep `bool` and
  let the store patch from its own arguments — implementer's choice, but the
  store must patch both keys from what the backend actually stored; if the
  backend intersects with paired ids, only a returned list is truthful →
  prefer `{ enabled, devices }`).
- `schema/boxes.rs` `ProjectBox`: `app_mobile_devices: Option<Vec<String>>`,
  `rename = "tabtivity_mobile_devices"` (brand-check allow comment + test
  pinning it to `brand::MOBILE_DEVICES_KEY`, as `app_mobile_access` does),
  `skip_serializing_if = "Option::is_none"`, and a **lenient**
  `deserialize_with` (malformed → `Some(vec![])`): a strict typed field would
  make one bad value fail `read_boxes` and with it every box command. Every
  `ProjectBox { … }` literal gains the field (`create_box`, schema tests).
- **Sibling fix (P1):** `commands/project_transfer.rs` import adopts the
  bundle's registry `entry.extra` wholesale (only `directory`/`mirror`/`vm`/
  OpenVPN are rewritten or dropped), so an imported `.tabtivityproj` arrives
  with `tabtivity_mobile_access: true` if the exporter had it on — a consent
  bypass today, and it would carry foreign device ids. Drop both
  `MOBILE_ACCESS_KEY` and `MOBILE_DEVICES_KEY` on import (and strip them from
  the exported entry); test it. Update `docs/context/project_transfer.md`.

### 2.2 Paired-phone list for the desktop without the host running

No desktop command exposes devices today; `MobileSettings` gets them only
through `mobile_admin { type: "devices" }`, i.e. only while the sidecar runs.
Add a read-only `mobile_paired_devices` Tauri command (`commands/mobile_control.rs`,
registered in `lib.rs`) backed by an AppHandle-free fn in
`services/mobile_control/auth.rs` (e.g. `pub fn read_paired_devices(control_dir)`)
that reads `<state_dir>/mobile-control/devices.json` exactly as
`AuthStore::open` does — `store::ensure_private_file` (the desktop runs as the
same uid, so the 0600 check passes; no-op on Windows), `store::read_json`
into the private `DeviceFile`, `schema == DEVICE_SCHEMA` — absent file → `[]`,
no write, no `host.key` read, never `public_key`. Return the existing
`protocol::AdminDevice` shape with `online: false` (one TS `Device` type for
both sources). The file is written by atomic rename, so a concurrent read sees
old or new, never torn. When the host is running, `MobileSettings` keeps using
`mobile_admin devices` (it adds `online`); the picker may merge `online` from
it when available.

### 2.3 Catalog filter (`services/mobile_control/discovery.rs`)

- `ProjectRecord`/`BoxRecord` gain the list. **Lenient**: read it as
  `Option<serde_json::Value>` (or a `deserialize_with`) and map
  present-but-malformed → `Some(vec![])`. A strict `Option<Vec<String>>` on
  `ProjectRecord` would fail the whole `projects.json` parse →
  `catalog_unavailable` for **every** project on every phone; on `BoxRecord`
  it would silently drop every box (`.ok()…unwrap_or_default()`).
- `ScopeSource` → `ResolvedProject` carry `devices: Option<Vec<String>>`
  (root scope: `None`, out of scope here).
- `Catalog::for_device(self, device_id: &str) -> Catalog` (or
  `retain_for_device(&mut self, …)`) drops every scope whose list is `Some`
  and does not contain `device_id`. `Catalog::project`, `tab` and `grants`
  then work as before on the filtered value. (There is no `Catalog::closed`:
  closed tabs come per project from the desktop's `Catalog` answer or
  `headless::closed_tabs`, and only after the project resolved — covered.)
- The cache stays device-agnostic (one `load`, filtered per request) — no
  per-device cache. Nothing else caches derived state across devices in a way
  that leaks: `HostState.readings` (git dots / turn readings per raw id),
  `terminal_registry` (per tmux name) and `holds` are only reached after a
  filtered lookup; opaque ids (`key_id`, files tokens sealed per raw id) are
  device-independent but useless without a filtered lookup.

### 2.4 Every phone route goes through the filtered catalog (`host.rs`)

Audit result (develop @ beeab6e2): **no route forwards a phone-supplied
project/tab id to the desktop or to `headless*` without resolving it through
`catalog(state)` / `catalog_fresh(state)` first.** So filtering at those two
functions is sufficient; the work is plumbing the device id.

- Auth helpers: `authenticate` and `authenticate_or_ticket` already return the
  device id (a ticket redeems through `OpenTicket.session` →
  `AuthStore::authenticate` → `Session.device_id`), but almost every handler
  discards it (`if let Err(error) = authenticate(…)`; `terminal` uses
  `.is_err()`). `mutation_guard` returns `Result<(), _>` — change it to
  return the device id. Recommended shape: a `Phone(String)` newtype that only
  these three helpers mint; `catalog(state, &Phone)` / `catalog_fresh(state,
  &Phone)` return the filtered catalog; a separate `catalog_unfiltered(state)`
  for `agent_tab_ref` only. The compiler then finds every call site.
- Helpers that load the catalog themselves and so gain a `&Phone` parameter:
  `tab_target`, `agent_tab_target`, `agent_tab`, `prompt_project`,
  `inbox_project`, `outbox_root`, `project_drop_box_root`, `markup_tab`,
  `markup_banner_files`, `files_scope`, `headless_tab_edit`,
  `create_headless`, `answer_headless_created`, `create_through_desktop` /
  `created_through_desktop` / `answer_created`, `prompt_mutation`,
  `schedule_mutation`, `undo_clear_headless`.
- Routes resolving inline (catalog lookup before any desktop/headless call):
  `projects` (then `GitStates`, joined on the filtered list), `activity`
  (desktop `Activity` answers all scopes; rows are joined on the filtered
  catalog — and its headless path passes the snapshot to
  `headless::activity`), `project` (then `Catalog{raw}` / headless),
  `create_tab`, `reopen_tab` (`closed_id` forwarded only after the project
  resolved), `launch_options`, `activate_project`, `tab`, `sign_in_tab`,
  `terminal`, `inbox_upload`, `markup_submit`, `prompt_send` (tab and project
  both from the same snapshot).
- Routes resolving through a helper above: `rename_tab`, `color_tab`,
  `order_tab` (both tab and anchor), `close_tab`, `sent_prompt`,
  `hold_prompt`, `edit_held_prompt`, `sign_in_callback`, `undo_clear`,
  `schedules`, `schedule_create/update/delete`, `agent_status`,
  `agent_transcript`, `prompts`, `prompt_create/update/delete`,
  `project_inbox_upload`, `inbox_described`, `inbox_file`, `outbox_list`,
  `outbox_file`, `outbox_delete`, `project_outbox_list`,
  `project_outbox_file`, `project_outbox_delete`, `desktop_images`,
  `attach_desktop_image`, `markup_questions`, `markup_answer`,
  `markup_dismiss`, `project_files_list`, `project_files_raw`.
- Post-action re-reads (`catalog_fresh` after a gated write in
  `rename_tab`/`color_tab`/`order_tab`/`headless_tab_edit`/`answer_created`,
  the headless fallbacks in `agent_status`, `attach_desktop_image`,
  `prompt_mutation`'s `Send`) are already behind a gated lookup; filtering
  them too is what the `&Phone` signature gives for free.
- Global routes, unaffected (they take no project/tab id): `status`, `todo`,
  `todo_mutate` (see §1 board note), `alerts`, `alerts_resolve`, `calendar`,
  `calendar_mutate`, `mail_*`, `push_*`, `global_inbox_upload`, `open_ticket`.
- `sign_in_callback` gates only on "some agent tab this phone sees", then
  delivers the localhost callback to whichever CLI listens — not bound to that
  tab. Pre-existing, unchanged by this plan; worth a line in the context doc.
- `agent_tab_ref` (push lookup) is not a phone request: it uses the
  unfiltered catalog and also returns the scope's `devices` so push can filter.
- The desktop side needs nothing (verified): the phone only ever sends opaque
  ids, which only the sidecar's catalog maps to raw ids; `MobileBridgeHost`
  gets raw ids from the sidecar alone, over the same-uid
  `desktop-control.sock`. `mobileScope` stays the switch/trust-tier repeat; it
  does not know and must not need to know which phone asked.
- `pty_bridge::attach`'s periodic re-check already calls
  `auth.authenticate(&token)`, which returns the session's device id — use
  that (`Some(device)` → `catalog.for_device(&device).grants(tab, tmux)`)
  instead of threading a new parameter; a session never changes device. So
  narrowing the list detaches an open terminal within ≤ 5 s (every fifth tick)
  with `access_revoked`, like turning the switch off does today. The upgrade
  route itself (`host::terminal`) checks through the filtered catalog via
  `Phone`.

### 2.5 Push (`push.rs`, `auth.rs`, `admin.rs` `AgentTurn`)

- `AgentTabRef` gains `devices: Option<Vec<String>>` (not serialized to the
  phone; also add it to the `AgentTabRef` literal in `admin.rs`'s tests).
- The send path is `admin::queue_notice` → `AuthStore::push_deliveries(notice)`
  (builds `paired` from `devices.json`) → `PushStore::deliveries(notice, tag,
  paired)`. Give `push_deliveries` an `allowed: Option<&[String]>` and pass
  `paired ∩ allowed`; calendar notices (`alarms.rs`, admin `Notify`) pass
  `None`. Only `Calendar` and `Agent` notice kinds exist.
- Cooldown/budget: `deliveries` records the agent tag in `recent` and spends
  the per-minute budget (`within_budget`) as soon as *any* subscription
  `wants` the notice — before the paired check. Since a tab's allowed set is
  the same on every turn, the cooldown itself is harmless; the real fix is to
  compute the eligible subscriptions (`wants && paired`) first and return
  `Ok(vec![])` — no budget spent, no tag recorded — when none remain.
- `attached` (some phone is watching the tab) needs no change: only an
  allowed phone can be attached.

### 2.6 Tests (Rust)

- discovery: list absent → all devices see it; list present → only listed;
  empty list → none; malformed value → none for that scope **and the other
  projects still load**; box same; switch off ignores list; key pinned to
  brand constant; record without the key round-trips.
- host: a phone not on the list gets `not_found`/the same error as an unknown
  id on project screen, tab open, create tab, files listing, files raw by open
  ticket, markup, schedule mutate, prompt send, terminal upgrade, and does not
  see it in `/projects` or `/activity`; a listed phone does. Use two paired
  test devices (`pair_device(&signing_key(n))` helper exists).
- pty_bridge: narrowing the list detaches with `access_revoked`.
- push: agent notice reaches only allowed subscriptions; a notice no allowed
  phone wants spends no budget.
- commands: `set_project_mobile_access` writes/removes both keys, rejects an
  empty or oversized list or a malformed id, other fields round-trip
  (Python-era entries too); `ProjectBox` with a malformed list still reads.
- project_transfer: an imported bundle never carries either Mobile key.

## 3. Desktop UI

### 3.1 Store / types

- `src/types/index.ts`: `[MOBILE_DEVICES_KEY]?: string[]` on `Project`
  (~l.1210) and `ProjectBox` (~l.1398), beside `MOBILE_ACCESS_KEY`.
- `stores/projects.ts` `setProjectMobileAccess(id, enabled, devices?: string[] | null)`
  (~l.1719), `stores/boxes.ts` `setBoxMobileAccess(…)` (~l.236) likewise;
  patch both keys from the backend's answer. No load-path change: registry
  extras pass through `get_projects`/`load_boxes` untouched. (`projects.ts`
  ~l.739 is the tmux-persistence gate `shouldPersistLocalTab`, which keys off
  access only — leave it.)
- A small hook `usePairedPhones()` (beside `MobileSettings`, e.g.
  `src/components/mobile/usePairedPhones.ts`) calling `mobile_paired_devices`,
  refreshed when the picker opens.

### 3.2 Picker component

One shared `MobileAccessPicker` (new file under `src/components/mobile/`),
used by both entry points. Contents, top to bottom:

1. Radio **All phones** (default; help: "including phones you pair later").
2. Radio **Only these phones** → checklist of paired phones (name, paired date,
   `online` dot when the host reports it). Unticking the last one is not
   allowed (or switches to the "turn off" hint).
3. When the project is already on: **Turn off Mobile access**.
4. Zero paired phones: only *All phones* is enabled, with a one-line hint that
   phones appear here once paired.

Reuse, don't invent (`feedback_copy_working_sibling` /
`feedback_unified_menu_layout`): render it through
`src/components/common/ContextMenuPortal.tsx` with `keepBelow` (button-anchored,
as the side panel's import ↓ menu opens it: `{ x: r.left, y: r.bottom + 2 }`);
rows from the checkable-menu sibling in `src/components/projects/BoxScopeChip.tsx`
(members group: `context-menu-group`, `context-menu-group-label`,
`context-menu-check` + `context-menu-checkmark` with `CheckboxIcon`/`SquareIcon`,
`context-menu-note`; the menu stays open across toggles). Portaled, so it
inherits the portal's colours — check the explicit `color` rule. Strings via
`useT()`, English keys for everything. Tag it `UntestedTag` id
`mobile.phonePicker` and register the row in `src/lib/untested.ts`.

### 3.3 Entry points

- **Project side panel** (`ProjectFilesView.tsx` ~l.1512 `side-panel-mobile-btn`,
  handler `toggleMobileAccess` ~l.507): clicking the phone button opens the
  picker anchored to it instead of toggling directly. Choosing *All* / ticking
  phones turns access on with that scope; the button's title says "Mobile: all
  phones" / "Mobile: 2 phones" / off. Note the button renders only while
  `mobileHostConnected && mobileEligible`, so here the host is always up.
- **Settings → Mobile** project and box lists (`MobileSettings.tsx` ~l.686 and
  ~l.705, `ToggleRow` from `src/components/layout/settingsUi.tsx` — there is no
  `components/settings/settingsUi.tsx`): keep the `ToggleRow` (toggle on =
  *All phones*, unchanged one-click), and add beside each enabled row a compact
  "All phones ▾" / "2 phones ▾" / "No phones ▾" button that opens the same
  picker. Search (`SEARCH_KEYS`) gets the new label key if it adds a
  searchable label.
- Revoking a device in Settings does not rewrite projects; the picker simply no
  longer lists it, and the row's count only counts paired ids (0 → "No
  phones", warning tone).

### 3.4 Tests (vitest)

Extend `src/__tests__/mobile/MobileProjectAccess.test.tsx` and
`MobileBoxAccess.test.tsx`: picker shows paired phones, *All* calls with
`devices: null`, *Only* with the ticked ids, last box cannot be unticked,
count label (incl. "No phones"), side-panel button opens picker instead of
toggling. `BrandMirror.test.ts` per §1.

### 3.5 Phone (mobile-web)

No change needed: a project that drops out answers `project_not_found` /
`tab_not_found`, which `mobile-web/src/connection.ts` already words as "This
project is no longer shared with the phone."; an open terminal ends with
`access_revoked` ("This device's access to the session was withdrawn."); a
stale `lastPlace` or a tapped old notice lands on the same errors. Narrowing
does not cancel prompts that phone already held or schedules it already made
(same as switching access off today) — say so in the help text.

## 4. Docs, QA, maps

- `docs/context/` has **no** Mobile doc (grep finds none; the design is spread
  over `docs/tabtivity_mobile_future_plan.md`, `docs/mobile_box_parity_plan.md`
  and `root_console.md` "On the phone"). Add `docs/context/mobile_access.md`
  (who may reach a scope: switch, trust tiers, box consent, per-phone list,
  fail-closed rules, downgrade note, board-names caveat, sign-in-callback
  note) and add `mobile_access` to AGENTS.md's context list.
- `docs/context/project_transfer.md`: import drops the Mobile keys (§2.1).
- `docs/filemap_backend.md` (`mobile_control/` row ~l.88, `mobile_control.rs`
  row ~l.68) / `filemap_frontend.md` (`mobile/MobileSettings.tsx` row ~l.56,
  new picker row): one-line updates.
- In-app help is `docs/help/mobile.md`: step 5 "Choose what the phone may
  open" (~l.49) and "If a phone goes missing" (~l.221, re-pair ⇒ new id,
  Lock down ⇒ scoped projects reach no phone). `DOCUMENTATION.md`
  "### Tabtivity Mobile" (~l.395): one paragraph.
- `todo/<mobile group>.md`: a 🖐️ manual QA box with the per-platform
  `✅ Works on …` / `❌ Doesn't work on …` children: pair two phones, limit a
  project to one, confirm the other neither lists nor opens it nor gets its
  agent push; narrow while a terminal is open → it detaches.

## 5. Phases

- **P1 — backend** (§1, §2 incl. the project-transfer sibling fix, Rust
  tests). Gate: cargo test + clippy + `npm run backend:stale` reported.
- **P2 — desktop UI** (§3, vitest) + **docs/QA** (§4). Gate: all six gates.
- Branch: the prepared worktree `.claude/worktrees/mobile-device-access`
  (branch `mobile-device-access`, at develop). The unmerged `hosted` branch
  rewrites large parts of `host.rs` (+636), `auth.rs` (+363),
  `commands/mobile_control.rs`, `commands/{projects,boxes}.rs`,
  `MobileSettings.tsx`, `stores/boxes.ts` — expect conflicts in whichever
  lands second; after both are in, add `mobile_paired_devices` to hosted's
  browser-client command allowlist if the picker should work there.

Not in scope: per-phone root console access, per-phone shell-tab switch,
per-phone push preferences per project, hiding project names on the to-do
board.

## Review notes (2026-10-04)

Checked against develop @ beeab6e2. Changed:

- §1: brand key goes in the `names!` table (it always mints a `LEGACY_*`
  twin — left unused, kept out of the migrator); TS mirror test named; device
  id format made exact; malformed list = fail closed per scope; Lock down
  consequence; to-do board caveat.
- §2.1: concrete id validation; `save_projects` verified safe; lenient
  `ProjectBox` field; **new sibling fix**: project import adopted the
  bundle's `tabtivity_mobile_access`.
- §2.2: confirmed no existing host-off device command; reuse `AdminDevice`.
- §2.3: lenient record parsing (a strict field could take down the whole
  catalog); removed the non-existent `Catalog::closed`; checked other caches.
- §2.4: replaced the "audit later" item with the audit result and the full
  route/helper list (no bypass found); `mutation_guard` returns `()` today;
  tickets already yield the device id; pty re-check uses its existing
  `authenticate(&token)` result instead of a new parameter.
- §2.5: real function names (`PushStore::deliveries` via
  `AuthStore::push_deliveries`); the cooldown worry replaced by the actual
  issue (budget/tag spent before the paired check).
- §3: corrected `settingsUi.tsx` path and line refs; dropped the wrong
  "load path ~l.739" item; named the sibling components to reuse; added
  "No phones" state; phone-side §3.5 (no change needed).
- §4: no Mobile context doc exists → new `docs/context/mobile_access.md`;
  real help source `docs/help/mobile.md`.
- §5: worktree and `hosted` merge note.

Open decisions for the user:

1. To-do board: keep listing every project name (and card project tags) to
   every phone, as today even with the switch off — or filter per phone too?
2. Should `set_*_mobile_access` drop unpaired ids itself (recommended) or
   leave stale ids to the UI?
3. Should the import sibling fix also apply to export (strip on export), or
   only on import?

### Decisions (2026-10-04, orchestrator)

1. To-do board project names: out of scope — pre-existing, shown even with the
   switch off; listed as a follow-up TODO, not filtered here.
2. `set_*_mobile_access` drops unpaired ids itself (reads `devices.json` via the
   §2.2 fn); an `Only these` list that ends up empty after that is refused.
3. Strip both Mobile keys on export **and** import (`project_transfer.rs`).
