# Markup tick + approve — plan

User request (2026-10-04): "add a check to the markers if the agent has
considered the remark, with a button to approve; then this remark vanishes."

The agent ticks off each mark it has handled; the mark shows a ✓ badge in the
markup view (desktop `PdfViewer` Mark up and the phone's `MarkupView`); the
reader taps it to approve and the mark is removed from the layer. Nothing is
removed without that tap — the "never delete or hide markers automatically"
rule (`docs/pdf_markup_rounds_plan.md`) stands.

## 1. What already exists (committed in badc490b)

- `markup::MarkupRequest.round: Option<String>` (phone body) and
  `pdf_markup_submit(.., round, mode)` (desktop), validated by
  `markup::valid_round` (1–16 chars, `[a-z0-9]`).
- With a round, `prompt()` names every **listed** mark `p<page> m<index+1>`
  (pictures: `m<index+1>`, page 1) — index into that page's submitted
  `marks` — and adds `tick_line(round)`, which points at `markup_done` "if you
  have it". No view sends a round yet, so all of this is inert.

## 2. Backend — `markup_done` (phase P1)

`services::markup_mcp`, beside `markup_ask` / `markup_withdraw`:

- Tool `markup_done { file: string (required), round: string, marks:
  [{ page: int ≥ 1, mark: int ≥ 1 }] (1..=200) }`. `file` resolved exactly as
  `markup_ask`'s (`resolve_file`, project-relative, `same_file` matching);
  `round` must pass `markup::valid_round`; duplicates collapse. Description and
  `INSTRUCTIONS` say: call it after making the change a mark asks for, with the
  references from the markup prompt; the reader approves each tick.
- Store: a second memory-only list of tick records `{ session, project,
  target, file, round, page, mark, created }`, pruned like asks (24 h
  `RETENTION`, dead sessions, a cap, e.g. 5 000 ticks). Ticking an
  already-ticked mark is a no-op. Ring `changed()` when anything new lands.
- Budget: own rolling hourly count per tab (e.g. 60 calls); refusals use the
  existing `refused(category, message)` shape (`invalid`, `file_not_found`,
  `budget`, `off`).
- Result: `{ "status": "ticked", "count": n }` — n new ticks.
- `root_mcp_security::tool` registry: add `markup_done` next to
  `markup_ask` / `markup_withdraw` (served to `Caller::Marker` only).
- Read side: `pub fn ticks(project, target, shown: Shown) -> Vec<TickView>`
  where `TickView { round, page, mark }` (camelCase; no session/project/file
  ids — the filter by file is done here, like `list`).
  - Desktop: new command `markup_mcp_ticks({ projectId, scheduleTargetId,
    path })` → `TickView[]`, registered in `lib.rs`, same path resolution as
    `markup_mcp_list` (path → `Shown`).
  - Phone: `GET /markup/questions` answer gains `ticks: [{ round, page, mark
    }]` beside `asks` (same `source` → `Shown` resolution). No raw ids cross
    the browser API.
- Tests: parse/validation, file binding, budget, dedupe, prune, `ticks()`
  filtering by target and file, the phone route's `ticks` field.
- Docs: `docs/context/markup_mcp.md` (the tool, why ticks are client-mapped).

## 3. Client core + desktop (phase P2)

Shared core in `mobile-web/src/markup/layer.ts` (the desktop imports it):

- `SentLayer` gains optional `log?: SentRound[]`, `SentRound = { id: string;
  pages: Record<number, Mark[]> }` — the marks exactly as that Submit sent
  them, page by page, in submitted order. Keep the newest `MAX_LOGGED_ROUNDS`
  (e.g. 6). `isLayer` validates it when present (records without it stay
  valid — persisted state must round-trip).
- `mintRound()`: 8 random `[a-z0-9]` chars (`crypto.getRandomValues`).
- `markSent(layer, only, roundId?)` appends the round to the log when given.
- `tickedMarks(layer, ticks) → { page, index, round }[]`: for each tick find
  the log round, `pages[page][mark-1]`, then the index in
  `layer.sent.pages[page].marks` of a mark equal to it (reference first, then
  structural equality). Unmatched ticks (erased, approved, older than the log,
  undone round) are dropped. Never matches an unsent mark.
- `approveMark(layer, page, index)`: removes that sent mark (no other change).
- `clearSent` drops the log too.

Desktop (`usePdfMarkup.ts`, `PdfMarkupLayer.tsx`, `PdfMarkupBar.tsx`,
`lib/viewers/pdfMarkup.ts`):

- Submit mints a round id, passes it to `submitPdfMarkup` (add the argument)
  and to `markSent`.
- Fetch ticks with the asks (`markup_mcp_ticks`, same triggers: pane visible,
  `markup-mcp-changed`, Mark up on).
- Each matched sent mark gets a ✓ badge at its bounding box's top-right
  corner (over the markup layer, like the question pins); clicking it approves
  (removes the mark; undoable like any edit is fine but not required). The
  strip shows "n done · Approve all" when n > 0.
- An undone apply round (`undoneRound`) — its ticks no longer mean anything:
  drop that round from the log when an undo succeeds.
- Untested id `desktop.markup.ticks`; i18n keys in English + de/es/fr/it.
- Tests: core functions (log, mapping, approve, isLayer round-trip with and
  without log) and the desktop flow (submit sends round; ticks → badge →
  approve removes the mark; Approve all).

## 4. Phone (phase P3)

`mobile-web/src/api.ts`, `MarkupView.tsx`, `style.css`:

- Submit mints a round, sends `round` in the body, `markSent(.., round)`.
- `listMarkupQuestions` returns `{ asks, ticks }` (or a sibling reader) —
  ticks validated (`round` string, positive integer `page`/`mark`).
- ✓ badges over ticked sent marks at their box's top-right corner, positioned
  like the question pins (`markup-pin` placement, both PDF frame and
  picture); tap approves. "n done · Approve all" beside the round status.
  Badges respect the arrival guard (no approve within `ARRIVAL_GUARD_MS` of a
  badge appearing — a pen mid-stroke must not approve).
- Untested id `mobile.markup.ticks`; i18n keys; `docs/help/mobile.md`.
- Tests in `src/__tests__/mobile/`.

## 5. Order

P1 → review → P2 → review → P3 → review → final whole-feature review. Gates
after each phase: `npm run build`, `npm test`, `cargo test`, `npm run lint`,
`cargo clippy --all-targets -- -D warnings`, `scripts/brand-check.sh`.
Handoff notes per phase in `docs/markup_tick_approve_handoff.md`.
