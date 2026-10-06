# Markup tick + approve — handoff

Plan: `docs/markup_tick_approve_plan.md`. One section per phase.

## P1

Backend `markup_done` + both read sides. Uncommitted, never live (needs a
window built with the backend; `npm run backend:stale` could not identify a
running process when this was written).

### Built

- **Tool** `markup_done` (`services::markup_mcp::TOOL_DONE`, third in `TOOLS`,
  in `tools()`, `INSTRUCTIONS`, dispatch in `handle_with`). Arguments
  `{ file: string, round: string, marks: [{ page: int, mark: int }] }`, all
  required, `deny_unknown_fields` at both levels.
  - `file`: trimmed, ≤ `MAX_FILE_BYTES`, resolved with
    `resolve_file(root, file, prove = true)` exactly as `markup_ask`'s (needs
    the `projects.json` folder; none → `file_not_found`).
  - `round`: `markup::valid_round` (1–16 `[a-z0-9]`).
  - `marks`: 1..=`MAX_TICK_MARKS` (200); `page` 1..=`MAX_PAGE` (100 000);
    `mark` 1..=`MAX_MARK` (= `markup::MAX_MARKS` = 5 000 — a Submit carries
    no more marks, so no page index can exceed it). Duplicates in a call
    collapse (first-named order kept).
  - Order of checks as `markup_ask`: switch (`off`) → arguments (`invalid`)
    → budget (`budget` + `retryAfterSecs: 3600`) → file (`file_not_found`).
  - Result `{ "status": "ticked", "count": n }`, n = ticks new to the store
    (0 when every one was already there).
- **Store**: memory-only `Vec<Tick>` (`tick_store()`), record `{ session,
  project, target, file (project-relative), round, page, mark, created }`.
  `prune_ticks`: 24 h `RETENTION`, dead sessions (`root_mcp::session_alive`),
  cap `MAX_TICKS` = 5 000 (oldest first). `sweep()` now prunes ticks too
  (PTY exit / revoke already call it). A tick equal on (project, target,
  round, page, mark) and `same_file(file)` is a no-op. `changed()` rings
  when new ticks land or any were pruned.
- **Budget**: `TICK_CALLS_PER_HOUR` = 60 per tab (by tab id, like asks), own
  map (`tick_rates`, `admit_tick`); the shared counter is `admit_in(map, tab,
  limit)`, `admit_rate` (asks) unchanged in behaviour.
- **Read**: `pub fn ticks(project, target, shown: Shown) -> Vec<TickView>`,
  oldest first, deduped on (round, page, mark) (a project file and its outbox
  copy may both carry one). `Shown::All` → every file's; `Shown::File(rel)` →
  `same_file`; `Shown::Elsewhere` → none (every tick names a file).
  `TickView { round: String, page: u32, mark: u32 }`, serialized camelCase
  (`{ round, page, mark }`), no session/project/file/path.
- **Registry**: `root_mcp_security::tool("markup_done")` → family `markup`,
  `marker: true` only (same arm as ask/withdraw). The existing test
  `registry_keeps_markup_to_its_own_class` iterates `TOOLS`, so it covers it.
- **Desktop command** `markup_mcp_ticks({ projectId, scheduleTargetId, path? })
  → TickView[]` (`commands/markup_mcp.rs`, registered in `lib.rs` after
  `markup_mcp_list`). Same `path` → `Shown` resolution as `markup_mcp_list`,
  now shared as `with_shown(project, path, |shown| …)`. Errors:
  `invalid_target`, `markup_failed`.
- **TS wrapper** (not wired into any UI): `src/lib/viewers/markupQuestions.ts`
  ```ts
  export type MarkupTick = { round: string; page: number; mark: number };
  export async function listMarkupTicks(projectId: string, scheduleTargetId: string, path?: string): Promise<MarkupTick[]>;
  ```
  Keeps only rows with a string `round` and positive-integer `page`/`mark`,
  strips any other key; non-array → `[]`; **rejects** like `invoke` (e.g. a
  stale backend without the command) — callers decide (the bridge catches).
- **Phone**: `GET /api/v1/tabs/{tab_id}/markup/questions[?source=…]` now
  answers `{ asks, ticks: [{ round, page, mark }] }`. Plumbing:
  - `protocol::MobileMarkupTick { round, page, mark }` (unknown keys dropped
    in decoding); `DesktopResponse::MarkupQuestions { asks, ticks }`, both
    `#[serde(default)]`.
  - Window bridge `MobileBridgeHost.markupQuestionsFor` calls
    `listMarkupQuestions` and `listMarkupTicks` with the same `path` in
    parallel; a failing ticks call answers `ticks: []` (asks unaffected).
    With no path (Focus banner) it is every file's ticks — the phone should
    ignore them there.
  - Sidecar `host.rs` `markup_questions` filters with `valid_tick`
    (`valid_round`, page 1..=`MAX_PAGE`, mark 1..=`MAX_MARK`) and always
    includes the `ticks` key. Headless/no window: `503 desktop_unavailable`
    as before (the ticks live in the window's process too); there is no
    other `/markup/questions` server to keep in step.
- **Docs**: `docs/context/markup_mcp.md` (three tools; new **Ticks** section:
  why ticks are mapped client-side by round id + page + mark index, file
  binding, store, budget, read side); `docs/filemap_backend.md` rows of
  `commands/markup_mcp.rs` and `services/markup_mcp.rs`.

### Tests added

- `services::markup_mcp`: `done_validates_before_anything_is_stored_and_off_refuses`,
  `done_binds_ticks_to_a_project_file_and_collapses_repeats` (resolve forms,
  outbox copy = same file, per-file/target filtering, wire shape),
  `done_has_its_own_budget` (both directions vs. the asks),
  `ticks_go_with_their_session_after_a_day_and_past_the_cap`; the audit test
  covers a `markup_done` call; the rpc test's `tools/list` compares `TOOLS`.
- `commands::markup_mcp`: `ticks_are_read_per_target_and_refuse_a_bad_one`
  (no path-resolving case: that reads `projects.json` from the state dir).
- `protocol`: ticks default to `[]`, cross as round/page/mark only, bad rows
  refuse the frame.
- `host.rs` `markup_questions_cross_as_leaf_names_and_answers_as_indices`:
  the route's `ticks` field, malformed ticks dropped, no path crosses.
- Vitest: bridge passes `ticks` (and `[]` when the command is missing),
  `listMarkupTicks` filtering/args/rejection (`PdfMarkupQuestions.test.tsx`).

### For P2 / P3

- Desktop fetch: `listMarkupTicks(projectId, scheduleTargetId, path)` with the
  same triggers as `listMarkupQuestions` (`markup-mcp-changed` is rung on new
  ticks too). Catch its rejection: a hot-reloaded frontend over the running
  stale backend has no `markup_mcp_ticks` yet.
- Phone: `ticks` is a sibling of `asks` in the `/markup/questions` JSON;
  absent only from an older sidecar — treat absent as `[]`. Validate as the
  plan says.
- A tick's `mark` is `index + 1` into `pages[page]` of the round **as sent**
  (the plan's `SentRound` log) — exactly what `markup::prompt` names with a
  round.
- Ticks vanish when the agent's session dies (tab closed/respawned) and after
  24 h — the ✓ badges then disappear; the marks stay (never auto-removed).
- `markupMcp.help` (i18n, Manage CLIs switch) still names only `markup_ask`;
  P2 may want to mention ticks when it touches i18n.

### Gates (2026-10-04)

- `cargo test -q`: 3625 passed, 3 ignored (14 suites).
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: passes.
- `npm test`: 7304 passed, 1 failed — `MobileIndicator.test.tsx › opens a
  paired phone's own access dialog from its Access button`, another
  session's in-flight paired-device work (`MobileIndicator.tsx`,
  `PairedDeviceDialog.tsx`), not touched here.
- eslint on the touched TS files: clean. `git diff --check`: clean.
- `scripts/brand-check.sh`: the 3 known pre-existing hits only.
- `npm run backend:stale`: no app process identified; Rust side not checked.

## P1 review

Reviewed the P1 diff in `services/markup_mcp.rs`, `commands/markup_mcp.rs`,
`lib.rs`, `root_mcp_security.rs`, `root_mcp.rs` (doc line),
`mobile_control/{protocol,host}.rs`, `MobileBridgeHost.tsx`,
`lib/viewers/markupQuestions.ts`, the two vitest files and the docs.

### Sound

- **Validation**: `deny_unknown_fields` on both levels; `file` trimmed,
  bounded, required; `round` through `markup::valid_round`; marks 1..=200,
  `page` 1..=`MAX_PAGE`, `mark` 1..=`MAX_MARK` (= `markup::MAX_MARKS`, the
  per-Submit total, so a valid upper bound for one page); negative/fractional
  numbers fail serde → `invalid`. Duplicates collapse in first-named order.
- **File resolution** is `markup_ask`'s exactly (`resolve_file(root, file,
  true)` under the `projects.json` root, never the in-folder `project.json`;
  lexical + regular-file proof, no links); no folder → `file_not_found`.
- **Check order** matches `markup_ask` (switch → arguments → budget → file);
  a refused call costs nothing; own 60/tab/h map, asks' budget untouched.
- **Locking**: the tick lock is taken alone (`sweep` drops the asks guard
  before it takes the ticks one), `session_alive` takes only the token map
  (never held while calling into this module), and `changed()` always runs
  after `drop(list)`. No lock order inversion.
- **Caller**: `handle_with` refuses any class but `Marker`; the registry
  arm serves `markup_done` to `Marker` alone (`registry_keeps_markup_to_its_own_class`
  iterates `TOOLS`).
- **No raw ids cross**: `TickView` is `{ round, page, mark }`; the sidecar
  re-validates (`valid_tick`) and the host test asserts no path/project id.
  `ticks` without a path (Focus banner) is every file's ticks — still only
  round/page/mark.
- **Older peers**: `DesktopResponse` is not `deny_unknown_fields`, so a
  stale sidecar ignores a hot-reloaded window's `ticks`; `ticks` is
  `#[serde(default)]`, so a window without it decodes as `[]`; the bridge
  catches a missing `markup_mcp_ticks` command (`ticks: []`, asks intact).
  The answer frame is capped at `MAX_DESKTOP_RESPONSE` (16 MiB), far above
  5 000 ticks.
- **Tool lists**: no other list of the markup tools exists in code (no
  `--allowedTools` for this server; Vibe gets `<server>_*`).

### Fixed

1. **One tab could push every other tab's ticks out** — the global cap
   (5 000) dropped the oldest ticks overall, and one tab may add 12 000 an
   hour (60 × 200). A prompt-injected agent could so clear the ✓ badges of
   every other tab. `prune_ticks` now cuts, past the cap, the oldest ticks of
   whichever (project, target) holds the most; test added (a quiet tab keeps
   all 10 while the flooding one loses its oldest 3). Doc line in
   `docs/context/markup_mcp.md` updated.
2. **Flaky test**: `ticks_go_with_their_session_after_a_day_and_past_the_cap`
   asserted `sweep()` returned true, but any parallel test's `ticks()` /
   `markup_done` prune removes the dead session's tick first. Now it sweeps
   and checks the store holds no tick of that session.
3. **`untested.ts` `markupMcp` row** listed only `markup_ask /
   markup_withdraw`; now names `markup_done` and that off refuses ticks too.

### Left

- **Dedupe ignores the session** (a tick already there from another live
  session of the same target blocks a new record, so it dies with the first
  session). Asks are keyed the same way and a schedule target is one tab, so
  two live sessions overlap only across a respawn, where the old one is
  revoked first. Not worth a change.
- **A whole `MarkupQuestions` frame fails to decode on one out-of-`u32`
  tick** (`page: -1`). Only the window's own `TickView` (`u32`) fills it, so
  unreachable; the asks frame has the same strictness.
- **`markupMcp.help` (i18n, 5 dicts)** and `docs/help/mobile.md` still name
  only `markup_ask`: nothing user-visible ticks until P2/P3, which touch
  i18n and the help page anyway — do it there.
- `same_file`'s leaf matching for outbox copies applies to ticks as to asks
  (a `b/draft.pdf` view of an outbox `…-draft.pdf` shares them). Round ids
  are per Submit, so a stray match needs the same round; harmless.

### P2/P3 readiness

What P2/P3 need is there: `listMarkupTicks(projectId, target, path)` with
the same triggers as the asks (`markup-mcp-changed` rings on new and pruned
ticks), and `ticks` beside `asks` on the phone route. Mapping must stay
client-side by round id; ticks vanish with the session/after 24 h — the
views must then drop the badge only, never the mark. P2 should catch the
command's rejection (hot-reloaded frontend over a stale backend). The phone
should ignore `ticks` on the banner request (no `source`).

### Gates after the review fixes (2026-10-04)

- `cargo test -q`: 3625 passed, 3 ignored.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: passes.
- vitest `MobileMarkupQuestions.test.tsx` + `PdfMarkupQuestions.test.tsx`:
  26 passed. eslint on the touched TS: clean. `git diff --check`: clean.

## P2

Client core + desktop. Uncommitted, never live. No Rust touched.

### Built

- **Core** (`mobile-web/src/markup/layer.ts`, shared with the phone):
  - `SentRound = { id; pages: Record<number, Mark[]> }`;
    `SentLayer.log?: SentRound[]` (oldest first); `MAX_LOGGED_ROUNDS` = 6.
  - `mintRound()` — 8 × `[a-z0-9]`, `crypto.getRandomValues` with rejection
    sampling (bytes ≥ 252 skipped, no bias); passes `markup::valid_round`.
  - `markSent(layer, only?, roundId?)` — with a round id logs each moved
    page's `layer.pages[n].marks` (the same array object). A repeated id
    replaces its older entry. Without an id an existing log is kept as is;
    no `log` key is written when the log is empty.
  - `tickedMarks(layer, ticks: MarkTick[]) → TickedMark[]`
    (`MarkTick = { round, page, mark }`, `TickedMark = { page, index, round }`):
    log round → `pages[page][mark-1]` → index in `layer.sent.pages[page].marks`
    by reference; by structural equality (`sameMark`) **only** when none of
    that round's marks on that page is still a sent object (a record rebuilt
    from a copy). Reason: after approving one of two identical marks, a
    structural fallback would hand the approved mark's ✓ to its twin.
    Equal twins in a copy are each claimed once. Unknown round, mark past the
    round's page, erased/cut/approved → dropped; only `sent` is searched, so
    never an unsent mark; deduped; sorted by page, index.
  - `approveMarks(layer, [{page,index}])` / `approveMark(layer, page, index)`
    — remove those sent marks only (page entry dropped when empty; log kept).
  - `forgetRound(layer, id)` — drops one round from the log (same layer when
    absent; no `log` key when it empties).
  - `clearSent` drops the log (it lived in `sent`); `clearAll(.., sent=true)`
    now also writes `sent: { pages: {}, rounds }` without the log.
  - `markBox(mark)` — bounding box in page units (ink: points ± half the
    widest line, `inkWidth(width, 1)/2`; box normalised; text = `textBox`).
  - `isLayer` validates `log` when present (array; `id` `/^[a-z0-9]{1,16}$/`;
    page keys `^[1-9]\d*$`; each a valid mark — the mark check is now the
    shared `validMark`). Records without `log` stay valid.
- **Scaling decision**: when a later round rescales a page's older sent marks
  (page size changed), `rescaleLog` rescales that page in every logged round
  too — a mark still on the sent side maps to its scaled object (same
  reference), one already gone is scaled with the same `scaleMark` (matches
  nothing anyway). So ticks still match after a rebuilt PDF changed size.
  `scaleMarks` was split into `scaleMark` + `scaleMarks`, output unchanged.
- **Storage decision**: `withinLimits` (store.ts) does **not** count the log,
  so the log can never fail a save. It stays bounded: `markSent` trims it
  (`trimLog`) to the newest 6 rounds and drops the oldest while its marks
  together exceed `SENT_LIMITS` (keeps at least the newest; one round ≤
  `LIMITS` < `SENT_LIMITS`). IndexedDB's structured clone stores the log's
  shared mark objects once and restores them shared (tested with
  `structuredClone`), so references survive a reload. `readLayer` now falls
  back to the record **without its log** when only the log is unreadable
  (sent marks kept), before the old unsent-only fallback.
- **Desktop**:
  - `lib/viewers/pdfMarkup.ts` `submitPdfMarkup(.., mode?, round?)` — new
    last argument, sent as `round` only when given.
  - `usePdfMarkup.ts`: Submit mints `roundId`, passes it; `markSent(now.present,
    pages, roundId)` only when every sent page's `marks` array is still the
    one the request body carried (else no log entry — ticks would index the
    wrong marks). Undo id → round id kept in `undoRounds` (ref Map); a
    **successful** `confirmUndo` forgets that round in past/present/future of
    the edit history (undo_gone/conflict/failure keep it).
  - Ticks read with `listMarkupTicks` from **every** agent tab of the project
    (not just the chosen target — the round id already ties a tick to one
    Submit; switching the picker must not hide ✓s), while Mark up is on and
    the pane visible, re-read on `markup-mcp-changed` (the listener now also
    runs when only ticks need it); a rejecting call counts as `[]`.
  - Returned `markup.ticks: MarkupTicks = { marks: TickedMark[], approve(page,
    index), approveAll() }` — `marks` empty unless `active && showSent`.
    `approve` commits through the history (Ctrl+Z / ↶ restores the mark and
    its ✓), only if the mark at (page, index) is still the one the badge was
    drawn for and still ticked; `approveAll` re-maps in the updater.
  - New `embed/pdf/PdfMarkupTicks.tsx`: `tickBadgesByPage(layer, marks)`,
    `PdfTickBadges` (button `file-viewer-pdf-question-pin is-tick`, ✓, centred
    on the box's top-right corner, clamped to the page, disabled while
    sending), `PdfTicksStatus` ("{count} done · Approve all", reusing
    `file-viewer-pdf-markup-round` + `file-viewer-zoom-btn file-viewer-zoom-text`,
    carries `UntestedTag desktop.markup.ticks`).
  - `PdfViewer.tsx`: `PdfPageCanvas` gets `tickBadges` (badges, disabled,
    onApprove) rendered right before the question pins; same gating as pins
    (`marking && ref.src === SELF`). `PdfMarkupBar.tsx` shows `PdfTicksStatus`
    first in the status line (which now also opens for ticks).
  - CSS (`viewers.css`, after `.is-inline`): `.file-viewer-pdf-question-pin.is-tick`
    = the question pin in `--success` (static shadow inherited, no animation),
    hover lighter, disabled dimmed with `var(--cur-default, default)`.
- **i18n** (en + de/es/fr/it): `pdfMarkup.ticks.done`, `.approveAll`,
  `.approveAllTitle`, `.approveTitle`; `markupMcp.help` now names both tools
  and the ✓/approve flow.
- **Untested**: `desktop.markup.ticks` row in `src/lib/untested.ts`.
- **Docs**: `docs/context/markup_mcp.md` Ticks section — core log/mapping and
  desktop bullets; `docs/filemap_frontend.md` row for `PdfMarkupTicks.tsx`.

### Tests

- `src/__tests__/mobile/MobileMarkupTicksCore.test.ts` (15): log as same
  objects, no log without id, MAX_LOGGED_ROUNDS, SENT_LIMITS trim, mintRound
  shape/uniqueness, reference mapping, later rounds on the same page,
  unmatched/unsent/dedupe/erased, structural fallback on a JSON copy, approved
  twin keeps no badge, rescale keeps mapping, approve/approveMarks,
  clearSent/clearAll/forgetRound, markBox, isLayer with/without/bad log,
  store round trip (structuredClone backend) + bad-log fallback.
- `src/__tests__/pdf/PdfMarkupTicks.test.tsx` (6): Submit sends an 8-char
  round and logs it; tick → ✓ at the box corner → click removes the mark,
  ↶ brings mark and ✓ back; Approve all (foreign round ignored); hidden with
  Show sent marks off; rejecting `markup_mcp_ticks` tolerated; undone apply
  round forgotten (badge gone, marks stay, no `log`).
- `PdfMarkupSubmit.test.tsx`: two exact-shape assertions now include `round`
  and the saved `log`.

### For P3 (phone)

- `MarkupView.tsx` compiles unchanged (`markSent(now.present, marked)`). P3:
  `const round = mintRound()`, send `round` in the `submitMarkup` body, then
  `markSent(now.present, marked, round)` — guard like the desktop: only when
  each page's `now.present.pages[n].marks` is the array the body sent
  (`history.present.pages[n].marks` at submit time). The picture path sends
  page 1 too, so the same log works (`m<index+1>`, page 1).
- Map with `tickedMarks(history.present, ticks)` (only while sent marks are
  shown); place the ✓ with `markBox(mark)` → top-right corner in page units;
  approve through `commit(history, approveMark(..))` / `approveMarks(..,
  tickedMarks(..))`, re-checking the mark identity as the desktop does.
- On a successful round Undo, `forgetRound` the Submit's round id (keep an
  undo-id → round-id map) across the history.
- Ignore `ticks` on the Focus banner request (no `source`).

### Gates (2026-10-04)

- `npm run build`: passes.
- `npm test`: 7326 passed, 1 failed — `MobileIndicator.test.tsx › opens a
  paired phone's own access dialog from its Access button` (another session,
  known). A `CursorPacks` failure from my first CSS (`cursor: default`) was
  fixed (`var(--cur-default, default)`).
- `npm run lint`: 0 errors, 31 warnings (pre-existing; none in touched code).
- `scripts/brand-check.sh`: the 3 known hits only. `git diff --check`: clean.
- No Rust touched (cargo gates not needed; `backend:stale` irrelevant).

## P2 review

Reviewed the P2 diff in `mobile-web/src/markup/{layer,store}.ts`,
`lib/viewers/pdfMarkup.ts`, `usePdfMarkup.ts`, `PdfMarkupTicks.tsx`,
`PdfViewer.tsx`, `PdfMarkupBar.tsx`, `viewers.css`, i18n (en + 4 dicts),
`untested.ts`, the two new test files and `PdfMarkupSubmit.test.tsx`.

### Sound

- **Nothing removes a mark but a click.** `tickedMarks` only reads;
  `approveMark(s)` is reached only from a badge click or Approve all, each a
  `commit` (Ctrl+Z / ↶ restores the mark and its ✓). Ticks vanishing
  (session gone, 24 h) drop badges only. Clear sent, erase, cut, approve and
  undo/redo all leave a stale badge click a no-op (identity re-check in the
  updater, plus "still ticked" against the newest ticks).
- **Old records**: `isLayer` ignores a missing `log`; an older build reading
  a record with `log` ignores the extra key (its `isLayer` destructures only
  `pages`/`rounds`) and its `markSent` simply drops it. A corrupt log loads
  without the log, sent marks kept (`readLayer`), tested. `withinLimits`
  never counts the log, and `trimLog` bounds it (≤ 6 rounds, ≤
  `SENT_LIMITS`), so the log cannot fail a save.
- **Round minted only for the marks the body carried**: `asSent` compares
  each submitted page's `marks` array by identity with the one the body was
  built from; any change meanwhile → no log entry (ticks then show nothing,
  which is the safe side). The backend's `pdf_markup_submit` takes `round`
  (committed earlier), and `prompt()` indexes into the submitted `marks`.
- **Rescale**: only `markSent` rescales a page (a Reload does not touch
  stored marks — `PdfMarkupLayer` draws them in the current page's units, as
  the badge places them), and `rescaleLog` keeps the log's references to the
  scaled objects. Erase keeps untouched marks by reference.
- **forgetRound across history**: after a successful `confirmUndo` only;
  `startHistory` at Submit means the history never predates the round.
- **Deviation (ticks from every agent tab)**: sound. A tick only matches a
  round id in this layer's own log (8 random chars per Submit), so another
  tab's ticks can at worst badge a mark of a Submit whose id it learned —
  still only a badge, never a removal. It keeps ✓s when the reader switches
  the target picker after a Submit. Cost: one in-memory `markup_mcp_ticks`
  invoke per agent tab per `markup-mcp-changed` (event-driven, no poll),
  only while Mark up is on and the pane visible, catching up on show — the
  same shape as the existing per-tab idle-asks reads.
- UI rules: all strings via i18n (5 dicts), `UntestedTag
  desktop.markup.ticks` on the strip, the pin's static shadow (no
  animation), sibling classes reused, badges gated like the question pins.

### Fixed

1. **Badges keyed by mark index could approve the wrong mark.** After an
   approve, the next ticked mark slid into the index and React reused the
   focused button: Enter again (or a held Enter's auto-repeat) approved it,
   and so did a double click where two badges overlap. Now
   (`PdfMarkupTicks.tsx`) the key carries the mark's identity (a `WeakMap`
   id), `TickBadge` carries the `mark`, `approve(page, index, mark)` removes
   only when `sent.pages[page].marks[index]` **is** that object (it used to
   compare with whatever `historyRef` held at click time), and a click with
   `event.detail > 1` (a double click's second) is ignored.
2. **Structural fallback could hand a ✓ to another round's twin.** With a
   round's only mark on a page approved, nothing of that round on the page
   was linked, so the equality fallback matched an identical mark of a
   *later* logged round. `tickedMarks` now never matches by equality a sent
   mark that any logged round holds by reference (a real copy has none, so
   the fallback still works there). Test added.
3. **`undoRounds` grew by one per apply Submit** (entries only left on a
   successful undo). Only the newest round's undo can run (`holdsUndo`), so
   the map is cleared at every Submit.
4. Tests added: double click approves one mark and the button goes with it;
   an approve whose mark is no longer at its index changes nothing; ticks
   from a second agent tab show (both tabs read); the cross-round twin case
   in the core. `docs/context/markup_mcp.md` updated for 1 and 2.

### Left

- **Approve all** also approves ticked marks on pages past a shrunk PDF's
  end (counted in "n done", no badge drawn). The reader clicked "Approve
  all" for that count; not worth a special case.
- The equality fallback can still match an identical mark from a round
  older than the log once the ticked round's page holds none of its own
  marks — needs exact point-for-point equality; negligible.
- `approve` does not itself refuse while sending; the badges and Approve all
  are disabled then, and an approve mid-send touches only the sent side
  (Submit's `asSent` looks at unsent pages), so it is harmless.

### For P3 (phone)

- Use the same identity contract: badges keyed by mark identity, approve
  with the mark object the badge was drawn for (`marks[index] === mark` in
  the updater, then re-check `tickedMarks(..)`), and ignore a repeated tap
  (`detail > 1`) on top of the plan's `ARRIVAL_GUARD_MS`.
- Clear the undo-id → round-id map at each Submit (only the newest round's
  undo can run).
- The core change (2) is shared — nothing for the phone to do.

### Gates after the review fixes (2026-10-04)

- `npm run build`: passes.
- `npm test`: 7330 passed, 1 failed — the known `MobileIndicator.test.tsx ›
  opens a paired phone's own access dialog from its Access button` (another
  session). `PdfMarkupTicks.test.tsx` 9/9, `MobileMarkupTicksCore.test.ts`
  17/17.
- `npm run lint`: 0 errors, 31 warnings (pre-existing; eslint on the touched
  files shows only the old `PdfViewer.tsx:3808` one).
- `scripts/brand-check.sh`: the 3 known hits. `git diff --check`: clean.

## P3

Phone. Uncommitted, never live. No Rust touched.

### Built

- **`mobile-web/src/api.ts`**: `MarkupBody.round?: string`.
  `readMarkupQuestions(tabId, source?, signal?) → { asks, ticks: MarkTick[] }`
  — ticks kept only with a `source` (the Focus banner's request keeps none),
  only rows with a non-empty string `round` and positive-integer
  `page`/`mark` (extra keys stripped), missing/non-array `ticks` → `[]`.
  `listMarkupQuestions` is now a wrapper returning `.asks` (callers unchanged).
- **`markup/questions.ts`** `useMarkupAsks` returns `ticks` too, from the
  same read (same 3 s poll, agent edges, never hidden/inactive/paused);
  unchanged ticks keep their array (`sameList`); a refusal/closed desktop
  clears them like the asks, offline/timeout keeps them.
- **`MarkupView.tsx`**:
  - Submit mints `roundId` (`mintRound`), sends `round`, and
    `markSent(now.present, marked, asSent ? roundId : undefined)` where
    `asSent` = every page's `marks` is still the array the body carried
    (`present` captured at Submit). `undoRounds` (undo id → round id) is
    cleared at each Submit; a successful `runUndo` `forgetRound`s it across
    past/present/future.
  - `ticked = tickedMarks(history.present, ticks)` only while `canMark &&
    showSent`; badges per page via `markBox`, centred on the top-right
    corner, clamped to the page (`TICK_BADGE` 26 px), rendered on PDF pages
    (before the `?n` pins, on every page like the pins) and on pictures.
    Keys carry mark identity (`WeakMap` id, as `PdfMarkupTicks.tsx`).
  - Tap → `approvable(mark)`: refused while sending or a stroke/erase/drag
    is under way (`gesture.current`), within `ARRIVAL_GUARD_MS` (imported
    from `MarkupQuestionsCard.tsx`) of that badge appearing (arrival times
    set in a `useLayoutEffect`, before paint; a badge that went and came
    back — e.g. after ↶ — arrives anew), within `TICK_REPEAT_MS` (350 ms) of
    the last approve, and `event.detail > 1` is ignored. The updater removes
    only when `sent.pages[page].marks[index] === mark` and it is still ticked
    (`commit`, so ↶ restores mark and ✓).
  - **Approve all** (`approveMarks(.., tickedMarks(..))` in the updater)
    waits out the newest badge's guard too.
  - Row under the round pill: `markup-round markup-ticks` with the done
    glyph, "{count} done", untested pill, `outbox-action markup-approve-all`
    (the pill's own secondary button look). Shown even without a pill (a
    reopened view over sent marks).
- **CSS** (`style.css`, after `.markup-pin-hit`): `.markup-pin.is-tick`
  (round, `#91e6a9` — the finished colour; pin's static shadow, no
  animation), disabled dimmed; `.markup-ticks` words green, button pushed
  right.
- **i18n** (en + de/es/fr/it): `mobile.markup.ticks.done`, `.approveAll`,
  `.approveAllTitle`, `.approveTitle` (tap wording).
- **Untested**: `mobile.markup.ticks` row; the pill sits on the ticks row.
- **Docs**: `docs/help/mobile.md` new section "Marks the agent has done"
  (desktop + phone; keywords), `DOCUMENTATION.md` markup_ask paragraph
  extended, `docs/context/markup_mcp.md` Ticks → **Phone** bullet,
  `docs/filemap_frontend.md` MarkupView row.

### Tests

- New `src/__tests__/mobile/MobileMarkupTicks.test.tsx` (8):
  `readMarkupQuestions` filtering / no-source / missing `ticks`; Submit sends
  an 8-char round, logs it, a tick on it (read on the agent edge) brings a ✓
  at the stroke's corner and "1 done" (foreign round ignored); tap inside
  the guard does nothing, `detail: 2` does nothing, a settled tap removes
  only the ticked mark, ↶ brings it and the ✓ back; Approve all (guarded,
  then removes both); older sidecar without `ticks` → nothing, no save;
  Show sent marks off hides badges and Approve all; undone apply round →
  badge gone, `log` gone, marks stay; a PDF page's badge clamped at the
  page's corner.
- Updated exact-shape assertions for the new `round` key / saved `log`:
  `MobileMarkupView.test.tsx` (1), `MobileMarkupRounds.test.tsx` (2).

### Gates (2026-10-04)

- `npm run build`: passes (includes `mobile:build` → `mobile:bundle`, so
  `mobile-dist/` is rebuilt; it reaches the phone only with a backend
  build that bakes it in).
- `npm test`: 7338 passed, 1 failed — the known `MobileIndicator.test.tsx ›
  opens a paired phone's own access dialog from its Access button`.
- `npm run lint`: 0 errors, 31 warnings (pre-existing); eslint on the
  touched files clean.
- `scripts/brand-check.sh`: the 3 known hits. `git diff --check`: clean.
- No Rust touched. `cargo test help_mcp` (for the edited help corpus,
  embedded in the binary) could not compile: another session's in-flight
  `services/api_meter.rs:671` (E0502). The new help section is plain
  markdown under an existing front matter; re-run `real_corpus_parses` once
  that compiles.

### Left / for review

- A pen tapping a ✓ while marking does not approve on iOS: the scroller's
  `touchstart` `preventDefault`s stylus touches (as it does for the `?n`
  pins), which suppresses the click. Fingers approve. Arguably the safe
  side; same as the pins.
- Phone ticks are read for the view's own tab only (the desktop reads every
  agent tab of the project): the phone's rounds go to that tab.

## Final review

Reviewed P3 in depth (`api.ts` `readMarkupQuestions`, `markup/questions.ts`,
`MarkupView.tsx`, `style.css`, i18n + 4 dicts, `untested.ts`, help /
DOCUMENTATION / context doc, `MobileMarkupTicks.test.tsx` and the two
updated shape tests) and the feature end to end (P1 prompt + tool, P2
desktop, P3 phone).

### Sound

- **Only a tap removes a mark.** Phone badges are keyed by mark identity;
  the updater removes only when `sent.pages[page].marks[index] === mark` and
  it is still ticked against the newest rendered ticks; refused while a
  Submit goes out or a stroke/erase/drag is under way, within
  `ARRIVAL_GUARD_MS` (1.2 s) of that badge's arrival (set in a layout
  effect, so before any paint a finger could hit), within 350 ms of the last
  approve, and on `detail > 1`. Approve all waits out the newest badge's
  guard. A pen stroke starting on the canvas never clicks a badge (the
  canvas handlers are siblings; a click across elements lands on their
  common ancestor). Ticks that vanish take the badge only.
- **Round id end to end.** Phone: `MarkupBody.round` → sidecar
  `MarkupRequest.round` (validated by `valid_round`) → `prompt`. Desktop:
  `submitPdfMarkup(.., mode, round)` invokes `pdf_markup_submit` with
  `round` (a single word, so camelCase = snake_case) → `submit_in_with_undo`.
  Both views build the body and the `present` snapshot from the same
  history value, log only when every page's `marks` array is unchanged, and
  the backend neither filters nor reorders marks (off-page marks refuse the
  whole request), so `m<n>` = index n − 1 of the submitted page, as
  `tickedMarks` maps it. Undo → `forgetRound` across the history on both.
- **Polling**: ticks ride the asks poll (3 s, `visibilityState` checked
  per tick and on `visibilitychange`), paused while answering, none for the
  Focus banner (no source). Validation keeps `{round, page, mark}` only.
- Persisted layers, i18n (5 dicts), untested rows/pills, static shadow,
  sibling classes: as P2/P3 reported.

### Fixed

1. **Picture rounds gave the agent no page to tick with.** A picture's marks
   are labelled `m<n>` alone (`mark_line`), but `tick_line` said every mark
   has `p<page> m<mark>` and `markup_done` requires `page ≥ 1`. `tick_line`
   now takes `picture` and says "`m<mark>`, all on page 1" for pictures;
   the tool's `page` description says "1 for a picture's marks (named
   `m<mark>` alone)". New Rust test
   `a_round_names_each_listed_mark_by_its_index_for_markup_done` (there was
   no test of the round references at all): PDF labels across two pages
   with an unlisted stroke keeping its index slot, the picture line, and no
   references/tick line without a round.
2. **Docs**: context doc Ticks intro says how pictures are referenced and
   that unlisted marks get no tick; the phone bullet says the phone reads
   only the view's own tab (a PDF reopened from the file browser shows no
   ✓). `docs/help/mobile.md`: each device shows ✓s only for the marks it
   sent (the round log lives in that device's layer), and where on the
   phone they show.

### Left

- The phone reads ticks for its own tab only (Focus chat's tab, or the tab
  its new-tab Submit opened). A PDF reopened from the file browser has no
  tab, so no ✓ until it is opened from the agent's chat. Same reach as the
  asks; documented. Lifting it needs a phone route over every agent tab.
- Ticks are per device: a round submitted on the phone is ✓-able only on
  the phone, a desktop round only on the desktop (the log is in each
  device's own layer). Documented in the help.
- The phone shows ✓s in reading mode too (any view that can mark); the
  desktop only while Mark up is on — both documented as such.
- `markupMcp.help` says "two markup tools" (ask + done; withdraw is part of
  asking). Left as is.

### Gates (2026-10-04)

- `cargo test -q`: all suites pass (lib 3471 passed, 3 ignored), including
  the new test and `help_mcp::real_corpus_parses` (the earlier
  `api_meter.rs` E0502 no longer reproduces).
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: passes (one first run failed on another session's
  in-flight `untested.ts` line 525 quoting, fixed by them a minute later).
- `npm test`: 7342 passed, 1 failed — the known `MobileIndicator.test.tsx ›
  opens a paired phone's own access dialog from its Access button`.
- `npm run lint`: 0 errors, 31 warnings (pre-existing).
- `scripts/brand-check.sh`: 4 hits — the 3 known plus
  `src/__tests__/mobile/MobileChatTurns.test.ts:261`, another session's
  uncommitted edit (not this feature's file).
- `git diff --check`: clean.
- `npm run backend:stale`: no app process identified; the sidecar serves the
  freshly built `mobile-dist` bundle; Rust side not checked.
