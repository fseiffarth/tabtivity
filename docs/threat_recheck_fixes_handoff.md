# Threat-model recheck fixes — handoff

Plan: [`docs/threat_recheck_fixes_plan.md`](threat_recheck_fixes_plan.md).
Each implementer and reviewer appends a short section: what changed (files),
tests added, gates run with results, open questions, and anything the next
step must know.

## Step 1 — implementer (#2342, #2343; gaps 8, 9)

**Grounding rate.** Fetched ai.google.dev/gemini-api/docs/pricing ("Last
updated 2026-10-01"): Gemini 3.x $14 / 1,000 search queries (5,000/month
free), Gemini 2.5 $35 / 1,000 *grounded prompts* (1,500/day free); Maps
$14 / 1,000 queries or $25 / 1,000 prompts. Priced per model
(`api_prices::Grounding::{PerQuery, PerPrompt}`); unknown model $35 / 1,000
per query (`GROUNDING_CEILING_USD`); free allowances not deducted.

**Files.**
- `src-tauri/src/services/api_prices.rs` — `Grounding`, `GeminiRates.grounding`,
  `GeminiUsage.{search_queries, grounded}`; `price_gemini` adds the fee and
  fills `Charge.web_searches` (as Anthropic web search). Grounding removed
  from "Not priced".
- `src-tauri/src/services/api_meter.rs` — scanner reads
  `candidates[i].groundingMetadata` of a top-level response only (decoys in
  function args/text ignored); queries told apart by a per-answer
  `RandomState` hash keyed by candidate position, max count over responses
  (no double count of repeated metadata, split metadata counted whole);
  metadata without queries = one grounded prompt; line break inside it →
  `Lost`. `may_ground(body)` (serde visitor over every key incl. duplicates/
  escapes; unparseable → true). Unsettled + may ground → ≥ 10 queries
  (`GROUNDING_QUERIES_ESTIMATE`). `Meter::worst_case(month)` = the estimate
  at its ceiling: whole output cap (`max_tokens`, else 128K; Gemini
  65,536 + 32,768 — Gemini's own fields still not trusted), body bytes/3 as
  1-hour cache writes (Anthropic), grounding estimate.
- `src-tauri/src/services/api_usage.rs` — `BookState.reserved` (micro-dollars
  per provider, memory only), `Book::{reserve, verdict, reserved}`,
  `Reservation` (released on drop). Ledger JSON unchanged.
- `src-tauri/src/services/api_proxy.rs` — early check now spent + held;
  after the body read `Budget::reserve(worst_case)` replaces the second
  verdict; `Metered.reservation` dropped after the charge in `settle`, or with
  the meter (connect error). New `Refusal::WouldPass` (429,
  `rate_limit_error` / `RESOURCE_EXHAUSTED`, no retry, "could cost more than
  is left … requests still in flight"); spent ≥ limit keeps `BudgetReached`.
- Docs: `todo/group-o-security.md` (#2342/#2343 Fixed lines),
  `docs/threat_model.md` (gaps 8, 9; Agent API proxy row; Fenced agent on
  Linux sentence), `docs/context/agent_authority.md`, `docs/api_chat_plan.md`
  (two annotations), `docs/help/agent-clis.md`, `docs/filemap_backend.md`.
- UI text: `settings.agentApiLimitHelp` in `src/lib/i18n.ts` + de/es/fr/it
  (said turns in flight overshoot). One-line edits in files other sessions
  are also editing.

**Tests added (8).** `api_prices`: grounding per query / per prompt / unknown
/ Maps / not doubled by the 2027 raise. `api_meter`: plain answer with decoys
(every split), stream with repeats + second candidate (every split), "a","a"
twice, past the distinct bound, cut-off/line-broken grounding → estimate,
`may_ground` spellings, `worst_case` for both providers. `api_usage`:
reserve/refuse/release exact, NaN, file shape. `api_proxy` e2e: two held,
third refused `WouldPass` before the provider; release on clean end, client
hang-up, upstream break; connect error holds and charges nothing.

**Gates.** `cargo test -q services::api_` 69 (68 pass, 1 ignored); full
`cargo test -q`: 3471 lib + all integration suites pass; clippy
`--all-targets -D warnings` clean; `npm run build` ok; `npm test`: 7342 pass,
1 fail — `src/__tests__/mobile/MobileIndicator.test.tsx` "opens a paired
phone's own access dialog from its Access button" ("Found multiple elements
with the role "button" and name "Close""), not from this step (last touched
by f71f27c1, another session's phone-access work); `npm run lint` 0 errors,
31 pre-existing warnings; brand-check: 3 hits, none in these files
(screenshots/, `mobile-web/src/terminal/inboxRefs.ts`). `backend:stale`: "No
Tabtivity process was identified … The Rust side could not be checked."

**Open questions / for the reviewer.**
- Ten queries for a cut-off grounded answer is an assumption (like the
  300/600 tok/s bounds); an answer running more is undercounted only when
  cut off.
- Gemini's reservation uses the provider cap (98,304 output tokens), not
  `maxOutputTokens`: ~$0.9 (3.5 Flash) to ~$1.8 (3.1 Pro long) held per turn.
  Near the limit turns are refused earlier than before — intended.
- Anthropic web searches are not reserved (they settle at $0.01 each); the
  only remaining overshoot besides grounding beyond ten.
- Never live: no real key/provider here.

## Step 1 — reviewer

**Verdict: approve after fixes.**

**Fixed.**
- `X-Goog-FieldMask` was forwarded (`api_proxy.rs` `DROP_REQUEST`). Google
  trims a complete answer to the masked fields, so a request masking out
  `groundingMetadata` (or part of `usageMetadata`) settled as a clean answer
  with no queries (or fewer tokens): a #2342 bypass, and an older token
  undercount too. The header is now dropped (the `fields` query parameter
  was already off the allowlist); `credentials_and_hop_by_hop_headers_are_not_forwarded`
  covers it. Threat model gap 8 row and the Agent API proxy row say so.
- Docs overstated the reservation: input is reserved from the body's size,
  but an answer can bill input the body only points to (Anthropic document/
  image URL sources, Gemini `fileData` URIs or `cachedContent`) or that server
  tools add during the turn (web fetch/search results). Up to the context
  window per request, so "a little more" was wrong. Corrected the gap 9
  residual, the Agent API proxy row and the `api_usage` module doc. Code left
  as is: reserving the full window would hold ~$4–8 a turn.

**Not fixed (unconfirmed, for the user).**
- Input-by-reference above can still overshoot by 64 × (window − body/3)
  in the worst case (a few hundred dollars). A fix would be to reserve the
  window when the body names a URL/file/cache source or a fetch tool.
- Maps grounding metadata has no query list: counted as one query on 3.x,
  even if Maps ran several.
- Streaming with `candidateCount` > 1: if a chunk lists one candidate at array
  position 0 by its `index`, identical query strings from different
  candidates fold together. Positional keying, not confirmed against a real
  stream.
- The same query string run twice in one turn, listed in separate chunks,
  counts once.
- `cachedContent` holding a Search tool hides it from `may_ground`, so a
  cut-off answer gets no 10-query floor. This needs a cache made outside the
  proxy (`cachedContents` isn't forwarded).

**No issue found.** Reserve is check-and-insert under one mutex (no TOCTOU).
No lock is held across an await. The `Reservation` drops exactly once
(settle `take()`, Pending/Tap/Metered drop on connect error, client abort,
upstream break, idle or stall cut, 3xx no-redirect answer). It is made only
after the body cap or timeout checks, so a refusal there holds nothing.
A `max_tokens` that is a string, negative, float or repeated falls back to
128K; a huge one saturates and is refused. NaN or ∞ → `u64::MAX` → refused.
Month rollover keeps holds (the charge lands in the new month). Unbilled
routes are free only (count/models). Ledger JSON unchanged; refusal codes
kept; i18n English plus four translations. The todo #2342/#2343 ticks are
accurate.

**Gates.** `cargo test -q services::api_`: 68 pass, 1 ignored; clippy
`--all-targets -D warnings` clean; `git diff --check` clean on touched files;
`backend:stale`: "No Tabtivity process was identified … The Rust side could
not be checked."

## Step 2 — implementer (#2344; gap 10)

**Choice: a branch moved before the click stays `stale_approval`.** The card
lists "these commits" against a branch tip; a tip that moved means the card no
longer describes the branch, so the user decides again (pushing the old SHA
anyway would also publish a tip the local branch may no longer contain after
a rewrite). A move *after* that check (during the up-to-120 s `ls-remote`)
no longer matters: the transport pushes the approved SHA itself. The remote
can only receive `remote..approved` (or a suffix of it if the remote moved
forward), all listed on the card.

**Files.**
- `src-tauri/src/services/git_push_mcp.rs` — `validate_sha` (40/64 lowercase
  hex); `refspec(sha, branch)` → `<sha>:refs/heads/<b>`; `transport` builds it
  from `plan.head` (approved SHA at Propose via `decide`, the validated
  post-preflight SHA at Apply). `preflight` re-runs the hook once when it moved
  the branch, so the stdin line (`refs/heads/<b> <sha> refs/heads/<b>
  <remote>`; local-ref field kept by name — `.githooks/pre-push` bumps only
  when it starts with `refs/`) names the SHA that is pushed; a hook that adds
  commits on the second run too → `preflight_failed`. `before_transport()`
  test seam (thread-local closure, no-op outside tests). Doc comments on
  `decide`/`decide_release`.
- `src-tauri/src/services/git_release.rs` — `pinned_tag_refspec`: reads
  `refs/tags/<t>` once, checks it peels to `plan.head` (`stale_approval`
  otherwise), pushes `<object>:refs/tags/<t>`. Covers the Release button too.
  The agent could re-point the local tag between creation and the transport;
  the old refspec pushed it by name (publishing an unpushed, unscanned commit).
  Existing cleanup (delete a tag this call made) now also runs on those
  refusals.
- Docs: `docs/context/git_push_mcp.md` (preflight re-run, branch refspec,
  approval semantics, release refspec), `docs/threat_model.md` (gap 10 Fixed;
  residual dropped from the Agent push row), `todo/group-o-security.md`
  (#2344 Fixed line), `docs/filemap_backend.md` (two rows).

**Tests.** `refspec_is_the_approved_sha_onto_one_branch_fast_forward_only`
(renamed; names/short ids/uppercase/operators refused);
`a_branch_moved_after_approval_never_sends_the_new_commit` (bare remote:
`decide` with the branch fast-forwarded in the seam → remote on the approved
SHA, the new commit absent from the remote's object store; Apply plan +
later commit → transport sends the validated SHA);
`preflight_gets_gits_arguments…` extended (two runs, second line names the
new tip; a hook that always commits is refused after exactly two runs);
`git_release::a_tag_re_pointed_before_the_transport_is_not_what_leaves`
(seam re-points the tag at an unpushed commit → remote tag peels to the tip,
commit absent; an already re-pointed tag → `stale_approval`).

**Gates.** `cargo test -q --lib git_push` 17 pass; `git_release` 7 pass;
full `cargo test -q --no-fail-fast`: lib 3472 pass, 1 fail, 3 ignored, all
integration suites pass. The failure is `help_mcp::tests::real_corpus_parses`
("mobile.md: too many or over-long keywords") — `docs/help/mobile.md` is
another session's uncommitted edit, not this step. clippy `--all-targets -D
warnings` clean; `git diff --check` clean on touched files; brand-check: one
pre-existing hit (`mobile-web/src/terminal/inboxRefs.ts`). `backend:stale`:
"No Tabtivity process was identified … The Rust side could not be checked."
`npm run build` / `npm test` not run (no frontend change).

**Open questions / for the reviewer.**
- The hook re-run doubles this repo's privacy scan per bumped agent push
  (seconds). A third-party hook that commits on every run is now refused
  instead of pushed; the native `git push` flow could not carry such a
  commit either.
- The re-run's line has the same `<remote sha>`, so `.githooks/pre-push`
  compares the bump commit's version with the remote's, sees a difference
  and does not bump again — checked by reading the hook, not run here.
- Never live: the user's own QA steps 2, 5 and 9 in
  `docs/context/git_push_mcp.md` cover it.

## Step 2 — reviewer

**Verdict: approve after one fix.** The step itself holds: every transport
(Apply, Propose, Release button, agent `git_release`) sends a validated full
hex SHA / tag object, never a name; a SHA-sourced `<sha>:refs/heads/<b>` is
still refused non-ff without `+` (checked by hand against a bare repo); the
refspec starts with a hex digit and branch/tag names are validated, so no
option injection; the tag object is read once through hardened git, peeled
to the plan's tip and pushed by id, so a swap after the read cannot change
what leaves. The preflight re-run uses the same `preflight_command` (same
fence, same env scrub, fails closed on `fence_unavailable`), stdin names the
new tip, at most two runs, and a commit landing after the second run is
refused. `before_transport()` is an empty fn outside `cfg(test)`. The bump
commit is listed on the card (re-read after round 0); `.githooks/pre-push`
does not bump again on round 1 (line 154 compares the bump's version with
the remote's). Docs match the code.

**Fixed (pre-existing, same gap class).** `refs/replace/*` is writable in the
fence. A `git replace --graft <tip> <remote>` made the plan's `git log`
(card) and the hook's scan skip a commit that `pack-objects` still sent (it
ignores replace refs), and a graft onto the remote tip let `merge-base` and
push's own fast-forward check pass a rewrite of the remote branch — both
reproduced in a scratch repo (git 2.53). Fix: `lane_git_command` (hardened +
`GIT_NO_REPLACE_OBJECTS=1`) for the lane's `git()` helper and its three
`merge-base` calls; the same env on `preflight_command` and on
`commands::git::push_transport_command`. Test
`a_replace_graft_neither_hides_a_commit_nor_fakes_a_fast_forward` (fails
without the env: card listed only the tip). Doc sentence added to
`docs/context/git_push_mcp.md` step 2. (`info/grafts` was checked too: push
follows it as well, so the remote rejects with missing objects — no gap.)

**Unconfirmed / listed only.**
- Release: a local tag the agent pre-created (or swaps in before the read)
  that peels to the tip is pushed with the agent's own message/tagger, or as
  a tag chain — text the card never showed and no scan covered; no commit can
  leave that way. Pre-existing ("a local tag already on the tip is reused").
- `ls_remote`/`git_release::plan` accept only 40-char remote SHAs, so a
  SHA-256 repo is refused as `remote_branch_missing` (fail closed;
  `validate_sha` itself accepts 64).
- `preflight` ends in `unreachable!` — correct today (round 1 always
  returns), but a panic there would leave the proposal `running`.
- The doubled privacy scan costs seconds per bumped push; harmless.

**Gates.** `cargo test -q --lib git_push` 18 pass, `git_release` 7 pass,
`commands::git` 91 pass; clippy `--all-targets -D warnings` clean;
`git diff --check` clean. Not run live.

## Step 3 — implementer (#2345; gap 11)

**Choice: the snapshots still cover the whole work tree.** Naming what changed
outside the project needs its before/after, so `begin`/`settle` are
unchanged (bounds still whole-tree). Only `undo` is scoped: conflict check,
blob reads, staging, removals and writes take only `diff-tree` entries under
the record's `prefix` (git's `--show-prefix` of the `projects.json` folder).
Same hardened git, own objects/index, nothing in `.git`, `openat(O_NOFOLLOW)`
walk from the work tree's top, all-or-nothing `Conflict`. A change outside
that was edited again after settle is no longer a conflict (it is not
touched).

**Files.**
- `src-tauri/src/services/markup_rounds.rs` — `in_project`; `Changes` gains
  `outside: Vec<String>` (top-relative, speakable, ≤ `MAX_LISTED`) and
  `outside_more` (wire `outsideMore`); `more` now counts only the project's
  unnamed files; `listed` builds the whole `Changes`. `remove_added` takes a
  `keep` depth: emptied folders are removed only below the project folder
  (before, an undo that removed the only file of an empty project folder
  removed the folder too). Module and `undo` docs.
- Wire: same JSON shape on both hosts (`json!(answer)` on the phone route,
  Tauri on the desktop) — two new keys; names are top-relative, never
  absolute, like `files`. A phone scoped to the project therefore sees the
  names of files changed *outside* it during its own round (noted as residual
  in the threat model).
- `mobile-web/src/markup/submitState.ts` `undoSummary` (shared confirm
  dialog text, desktop + phone): appends "Outside this project, left as they
  are: …" (and "No file in this project changed…" when only outside ones
  changed). `mobile-web/src/api.ts` `MarkupUndoChanges` + `undoChanges`
  parse them (older desktop → none); `src/lib/viewers/pdfMarkup.ts`
  `PdfMarkupUndoChanges` optional fields. i18n `mobile.markup.undo.outside`,
  `mobile.markup.undo.noProjectFiles` in en/de/es/fr/it. The chat note to the
  agent (`markupUndoNote`) is unchanged.
- Docs: `todo/group-o-security.md` (#2345 Fixed), `docs/threat_model.md` (gap
  11, PDF markup Submit / Undo row), `docs/filemap_backend.md`,
  `DOCUMENTATION.md`, `docs/help/mobile.md`, dated notes in
  `docs/pdf_markup_direct_apply_plan.md` / `_handoff.md`.

**Tests.** Rust (replacing `a_project_below_the_repo_top_names_only_its_own_files`):
`a_project_below_the_repo_top_undoes_only_its_own_files_and_names_the_rest`
(project `paper/` + sibling `other/` + top file; inside edit and new nested
file restored, folder removed; top edit, sibling edit — edited again after
settle — and sibling new file survive and are named; wire keys),
`a_change_outside_the_project_neither_conflicts_nor_is_listed_past_the_cap`,
`an_empty_project_folder_stays_after_its_only_file_is_undone`. TS:
`MobileMarkupRoundsCore.test.ts` two `undoSummary` cases.

**Gates.** `cargo test -q --lib markup_rounds` 25 pass; full `cargo test -q`:
lib 3475 pass, 1 fail (`help_mcp::tests::real_corpus_parses`, "mobile.md:
too many or over-long keywords" — the same pre-existing failure step 2
reported; my `docs/help/mobile.md` edit is body text only), 3 ignored, all
integration suites pass; clippy `--all-targets -D warnings` clean;
`npm run build` ok; `npm test`: 7342 pass, 1 fail (`MobileIndicator.test.tsx`
"opens a paired phone's own access dialog…", multiple "Close" buttons — the
same pre-existing failure step 1 reported); `npm run lint` 0 errors, 31
pre-existing warnings; `npm run mobile:bundle` ok; brand-check: pre-existing
hit only (`inboxRefs.ts`); `git diff --check` clean. `backend:stale`: "No
Tabtivity process was identified … The Rust side could not be checked."

**Open / for the reviewer.**
- Inside the project, edits by the user or another tab between Submit and
  settle are still reverted (inherent; dialog names every file first;
  nothing through `local_loss`). Stated as residual.
- Naming sibling-project files to a project-scoped phone is a small
  disclosure; drop `outside` on the phone route if that is unwanted.
- Never live.

## Step 3 — reviewer

**Verdict: sound after two fixes.** Prefix logic holds: `--show-prefix` is
git's own (physical cwd, ends in `/`), so `proj/` never matches `proj2/…`;
`..`/empty names are refused by `walk`; a project at the repo top has prefix
`""` (`keep` 0, whole tree as before). Symlinked project folder: the prefix is
the real path, as `diff-tree`'s paths are. Case mismatch (case-insensitive FS)
can only misfile an inside path as outside — left alone, the safe side.
Non-UTF-8 names: `split_z` is lossy, the lossy path does not exist → inside it
is a conflict (refused), outside it is named with U+FFFD on the desktop. Inside
conflicts still refuse all-or-nothing; every write/removal is an inside path;
`remove_added` stops at the project folder. No new git verb; own objects/index
unchanged.

**Fixed.**
- *Lead's change:* the phone route sends no outside names. `markup_rounds`
  `Changes::outside_counted` (names → `outsideMore`) and `outside` is skipped
  when empty; `mobile_control/host.rs` `markup_undo_preview` / `markup_undo`
  wrap their call with it (desktop Tauri commands keep the named list). Phone
  `api.ts` `MarkupUndoChanges` is count-only (`outsideMore`; names, if a
  desktop ever sent them, are counted, never kept). `undoSummary`: no names +
  count → `mobile.markup.undo.outsideOne` / `outsideCount` ("3 files outside
  this project stay as they are."), en/de/es/fr/it.
- *Data loss:* a file moved **into** the project from outside (`--no-renames`
  → outside delete + inside add, same blob) was removed by the undo while its
  original was not put back — the only copy gone. `moved_in` now keeps such a
  file (not touched, not a conflict) and lists it top-relative in `outside`.
  Moved out: the inside file is restored, the outside copy stays (no loss).
- Tests: Rust `a_file_moved_into_the_project_stays_and_its_names_reach_no_phone`
  (move in + move out, nothing written outside, phone JSON has no `outside` key
  and no names); TS `MobileApiClient.test.ts` (count-only parse, names counted,
  older desktop), `MobileMarkupRoundsCore.test.ts` (count-only wording).
- Docs: threat model gap 11 + Submit/Undo row, todo #2345, filemap_backend,
  DOCUMENTATION.md, help/mobile.md.

**Unconfirmed / residual (not fixed).**
- On the desktop a moved-in file is shown under "Outside this project, left as
  they are" with its top-relative name — accurate about being left, loose about
  "outside".
- No route-level test with a parent repo (the host fixture's project is the
  repo top); the phone wiring is two closures, covered by the unit test.
- `locate` trusts git's prefix shape; a non-empty prefix without a trailing
  `/` would break `in_project` (git never prints one).

**Gates.** `cargo test --lib markup_rounds` 26 pass (+ route test
`an_apply_submit…` pass); clippy `--all-targets -D warnings` clean;
`npm run build` ok; vitest MobileApiClient, MobileMarkupRoundsCore,
MobileMarkupRounds, MobileMarkupView 71 pass, `src/__tests__/pdf` 375 pass;
`npm run lint` 0 errors (31 pre-existing warnings); `npm run mobile:bundle` ok;
brand-check: pre-existing hits only; `git diff --check` clean;
`help_mcp::real_corpus_parses` still fails on mobile.md keywords
(pre-existing, frontmatter, untouched). `backend:stale`: "No Tabtivity process
was identified … The Rust side could not be checked." Never live.

## Step 4 — implementer (#2346; gap 12)

**Choice: extend `files::ProjectDir`, no new helper.** It is now
`pub(super)` (Windows: `pub(in mobile_control)`) with `open_root`,
`lookup_dir` (`Ok(None)` = missing, `Err` = link/file/other), `create_dir`
(`mkdirat`, EEXIST ok), `create_file` (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0o666),
`remove_file` (`unlinkat`), plus the existing `open_file`/`entries`. Every
single-name op checks `plain_segment` (= `valid_segment` without the
courtesy hiding, which the drop boxes need: `.tabtivity`, `.<leaf>.tab`).
The file browser still filters hidden names in `list`/`walked_paths`.

**Files.**
- `mobile_control/files.rs` — the above; `segment_cstr`; `open` = `open_root`
  + walk (same error order).
- `mobile_control/files_windows.rs` — `open_at` → `nt_create` (one name,
  NTSTATUS → `io` kind); `lookup_dir`, `create_dir`/`create_file`
  (`FILE_CREATE`), `remove_file` (DELETE open with `FILE_OPEN_REPARSE_POINT`
  + `FileDispositionInfo`); single-name check and enumeration use
  `plain_segment`.
- `mobile_control/outbox.rs` — `drop_dir` returns the held `ProjectDir`
  (`Unavailable` for any link/non-folder on the way); `probe`/`probe_as`/
  `read_probed`/`sender`/`source`/`remove` work relative to it; listing via
  `entries()` (`list_in`); `open_sniffed`/`open_regular` removed (no callers).
- `mobile_control/inbox.rs` — `make_drop_dir` (mkdirat + lookup per
  component), `store_at` writes with `create_file`, removes a half-written
  file with `remove_file`; `inbox_total` via `entries`+`open_file`; new
  `kind(root, leaf)`. Covers phone uploads, headless uploads, markup Submit
  copies/page PNGs and (harmlessly) the global inbox.
- `mobile_control/markup.rs` — `inbox_png` → `inbox::kind` (one function;
  the other session's hunks untouched).
- `brand_migration/compat.rs` — `take_send_alias_marker_with(pair, remove)`;
  the path version wraps it (tests).
- Docs: todo #2346, threat model gap 12 + the two Tier 2 rows,
  `filemap_backend.md` (`mobile_control/` row's `open_sniffed` mention,
  `files_windows.rs` row).

**Behaviour change:** a `.tabtivity/outbox` (or `inbox`) link pointing to
another folder *inside* the project used to be served; now it is
`Unavailable` like any link.

**Tests (Unix).** outbox: `a_linked_project_dir_or_outbox_is_refused_for_every_door`
(`.tabtivity` link out, `outbox` link into the project, `.tabtivity` a file →
list/read/remove/exists refused, targets untouched),
`a_project_dir_swapped_for_a_link_mid_request_never_reaches_the_links_target`
(held outbox; swap; list/read/delete stay in the real folder; fresh request
`Unavailable`). inbox: `a_linked_project_dir_is_refused_for_writes_and_reads`,
`a_linked_inbox_is_not_read_back`,
`a_project_dir_swapped_for_a_link_after_the_walk_keeps_the_write_inside`
(also `AlreadyExists` and a leaf link refused by `create_file`). Existing
outbox/inbox/files/markup/host tests unchanged and passing.

**Gates.** `cargo test -q --lib mobile_control` 359 pass; full
`cargo test -q --no-fail-fast`: lib 3481 pass, 1 fail
(`help_mcp::tests::real_corpus_parses`, pre-existing mobile.md keywords),
3 ignored, all integration suites pass; clippy `--all-targets -D warnings`
clean; Windows `cargo clippy --target x86_64-pc-windows-msvc --lib --tests`
(RC/lib shims) compiles, no warning in touched files (pre-existing warnings
elsewhere, e.g. `apps.rs`, `git_overview.rs`); macOS not compiled here
(`openat`/`mkdirat`/`unlinkat` are POSIX). brand-check: pre-existing hits
only; `git diff --check` clean. `backend:stale`: "No Tabtivity process was
identified … The Rust side could not be checked." No frontend change, so
`npm run build`/`npm test` not rerun. Never live.

**Open / for the reviewer.**
- Windows drop-box writes/deletes are new native code, compile-checked only.
- The project root itself is still opened by its canonical path (as
  `files.rs`); only what is below it is handle-relative.
- The global inbox (`<state_dir>/inbox`) listing/open/delete stay path-based
  (state dir, outside every fence); only its write goes through the walk.

## Step 4 — reviewer

**Verdict: sound; one sibling bug fixed.** No path-based open/stat/list/
delete/write on a project drop box or marker is left: `outbox.rs`
(`list_in`, `read_probed`, `probe_as`, `sender`, `source`, `remove` + both
markers, old-name send marker via `take_send_alias_marker_with`), `inbox.rs`
(`store_at`, `describe`, `read`, `kind`, `inbox_total`), `markup::inbox_png`
all start from `ProjectDir::open_root`. Remaining `.join(` hits on drop
boxes are tests, or build the display string `<OUTBOX_DIR>/<leaf>` (host
`file_row`, markup `ResolvedSource`), then read through `outbox::read`/
`exists`. Legacy `.eldrun/{inbox,outbox}` are never read here
(`brand_migration::project` moves them); the path-based
`take_send_alias_marker` is test-only now.

Checked: `plain_segment` (empty/`.`/`..`/`/`/NUL; Windows `\`, `:`) guards
every single-name op via `segment_cstr`/`nt_create`. Control characters and
Windows device names, trailing dots/spaces and 8.3 names are not rejected,
but none can leave the held folder (NT relative opens do no DOS-device or
trailing-dot mapping; a short name aliases only a sibling in the same
folder), and `store` never produces them. Unix: `O_NOFOLLOW|O_DIRECTORY|
O_CLOEXEC` per step, regular-file check from `fstat` of the opened fd,
`O_EXCL` create (0666 & umask, as before), `unlinkat(…, 0)` gives `EISDIR`
on a folder and removes a link itself; no fd leaks. Windows:
`FILE_OPEN_REPARSE_POINT` + `plain_metadata` on every step and leaf,
`FILE_CREATE` relative to the held handle (collision on a reparse point →
`lookup_dir` refuses it), delete with `FILE_NON_DIRECTORY_FILE|
FILE_OPEN_REPARSE_POINT` (a junction is `FILE_IS_A_DIRECTORY`, never
emptied). Fresh project: `mkdirat` makes `.tabtivity` then `inbox`.
Global inbox: `<state_dir>` is masked in every fence
(`agent_fence::mask_private_state`), so its path-based list/open/delete are
out of scope — agreed.

**Fixed:** `inbox::store_at` built `<stamp>-<safe_name>` bounded in
*characters* (80), so a long name in a wide script (80 CJK chars, emoji) was
>255 bytes: `plain_segment` refused it (`Io`, HTTP 500). Linux failed the
same way before (`ENAMETOOLONG`); on Windows (UTF-16 bound) it is a
regression of this step. The stem is now cut at a character to leave room
for the extension and a `-1000` suffix. Test
`a_long_name_in_a_wide_script_still_lands`.

**Unconfirmed / not done:** Windows `remove_file` with plain
`FileDispositionInfo` fails on a read-only file (std's `remove_file` may
clear that via POSIX semantics) — Windows runtime unverified anyway. A
hard link in the outbox (`st_nlink > 1`) is still served; the project is a
bind mount, so a fenced agent's cross-mount `link()` gets `EXDEV`.

**Gates.** `cargo test -q --lib mobile_control` 360 pass; clippy
`--all-targets -D warnings` clean; Windows clippy (`--lib --tests`, shims)
compiles, only the pre-existing `git_overview.rs:679` warning;
`git diff --check` clean. `backend:stale`: no Tabtivity process
identified, Rust side not checked. Never live.

## Step 5 — implementer (#2347; gap 13)

**Choice: reuse `home_io::HomeFile`, one small shared helper in
`git_guard`.** `git_guard::{read_info_exclude, edit_info_exclude,
open_info_file}` take the git dir as the handle root: `info` opened
`O_DIRECTORY|O_NOFOLLOW` (missing → `mkdirat` only for an edit), the file
`O_NOFOLLOW|O_NONBLOCK` and checked regular on the opened inode, a write =
exclusive temporary in the held `info` + `renameat` (so a link swapped in
after the check is replaced, never followed). A linked/non-folder `info` or
a linked/FIFO/folder/non-UTF-8 `exclude` → `Err(why)`, left untouched. A
`symlink_metadata` beforehand only words the refusal. Rewritten files are
now `0600` (HomeFile's mode; git's template gives `0644`) — harmless for a
single user.

**Writers found and changed.**
- `brand_migration/project.rs` — `update_exclude` (rewrite; reads first so
  a missing exclude still creates nothing), `exclude_folder_ignored_under_old_name`
  (append; now also skips when the rule is already there), `needs_work` and
  `gitignore_names_old_folder_only` (reads; a FIFO can no longer hang the
  launch sweep). Refusals go to `report.left` ("info/exclude left alone: …").
  `remote_script`: `plain()` shell function (`[ ! -L ]` on `info` and
  `exclude`, `-d`/`-f` when present) gates the rewrite and the append, re-run
  after `mkdir -p` and before `mv`; temp via `mktemp "$exclude.XXXXXX"`
  instead of the guessable `exclude.tmp$$` (a `>` into a planted link there).
- `commands/git.rs` — `exclude_app_dir` (worktree add) local half via
  `edit_info_exclude`, refusal `eprintln!`ed, worktree still created; remote
  half factored into `remote_exclude_script()` with the same `[ -L ]`/`[ -d ]`/
  `[ -f ]` gate before `>>`.
- Sibling: `markup_rounds::file_names_conversion(path)` →
  `info_attributes_name_conversion(common_dir)` via `open_info_file` + a
  `take(MAX+1)` read. **Behaviour change:** a linked/FIFO/unreadable
  `info/attributes` now counts as naming a conversion (`NoUndo::Filtered`) —
  git follows the link, so it can't be vetted; before it counted as none,
  and a FIFO swapped in after the `lstat` blocked Submit.
- No other writer of anything under `.git/info/` (no sparse-checkout or
  attributes writer; `git_overview.rs:688` is a test).

**`info/` not added to `git_guard`'s read-only mounts.** Verified with a
`chmod a-w .git/info` repo, git 2.53: `git sparse-checkout set` fails
(`Unable to create …/info/sparse-checkout.lock`), and `git repack`/`git gc`
(so auto-gc after commits) print `error: unable to update .git/info/refs`.
That breaks normal agent git use, so the host-side handle I/O is the fix.

**Tests.** `git_guard`: `a_plain_exclude_is_appended_once_and_a_missing_info_is_made`,
`a_linked_exclude_or_info_is_refused_and_its_target_untouched` (also no
temporary left in the link's target), `a_fifo_or_folder_exclude_is_refused_without_blocking`.
`brand_migration::project`: `a_linked_exclude_or_info_is_never_written_through`
(local sweep and remote script × linked `exclude` / linked `info`; the
target holds the old rule, so both the rewrite and the append would fire).
`commands::git`: `the_remote_exclude_script_appends_once_and_never_through_a_link`.
`markup_rounds`: `info_attributes_naming_a_conversion_have_no_undo` extended
(link → Filtered, FIFO → Filtered without blocking).

**Gates.** Full `cargo test -q --no-fail-fast`: lib 3487 pass, 1 fail
(`help_mcp::tests::real_corpus_parses`, pre-existing), 3 ignored, all
integration suites pass. clippy `--all-targets -D warnings` clean. Windows
`cargo clippy --target x86_64-pc-windows-msvc --lib --tests` (shims)
compiles, no warning in touched files. `git diff --check` clean;
brand-check: pre-existing hits only, none in touched files.
`backend:stale`: "No Tabtivity process was identified … The Rust side
could not be checked." No frontend change. Never live.

**Open / for the reviewer.**
- Remote scripts are test-then-act in a shell (no `O_NOFOLLOW` there): a
  link planted between the `[ -L ]` and the `>>` is still appended through.
  Stated as the residual in the threat model.
- Windows uses `home_io`'s path-based `symlink_metadata` checks (no fence
  there); runtime unverified.
- The git dir itself is opened by name (it came from `rev-parse`; a main
  `.git` is pinned by `git_guard` inside the fence).
- Docs: todo #2347 ticked; threat model gap 13 + Background git row;
  `filemap_backend.md` `git_guard.rs` row; `home_io` module doc. No
  `docs/context/` file described the old behaviour.

## Step 5 — reviewer

**Verdict: sound after fixes.** Coverage is complete: the only writers or
readers of a git dir's `info/` in `src-tauri/src` are the three helpers'
callers (`brand_migration/project.rs`, `commands/git.rs` `exclude_app_dir`,
`markup_rounds`); `git_overview.rs:688` is a test, `markup_rounds:1288` is
its own state dir. Refusals never fail the main job (report `left`,
`eprintln!`, `NoUndo::Filtered` → Submit falls back to List mode with "the
repository converts files…"; slightly off-worded for a link, acceptable).

**Fixed.**
- *Mode (lead's decision).* `home_io::HomeFile::write_keeping_mode(bytes,
  keep)` (shared `write_as`): temporary created `0644` less umask, then
  `fchmod`ed to exactly `keep` before `renameat`; `write` keeps `0600`.
  `git_guard::read_text` returns the mode from `fstat` on the opened fd;
  `edit_info_exclude` passes it. A missing `info` is now `mkdir`ed by name
  (default `0777` less umask, like git; `mkdir` never follows a link at the
  last component) instead of `HomeDir`'s `0700`, then opened
  `open_existing` (so `create_private_dir(git_dir)` is no longer reached).
- *Read cap.* `MAX_INFO_BYTES` (4 MiB) via `take`; a larger (sparse)
  `exclude` is refused, not read whole (was an unbounded `read_to_end`).
- *Remote migration script.* `mktemp` left the rewrite `0600`: now
  `stat -c %a || stat -f %Lp` → `chmod` on the temporary (neither → `0600`).
  A failed `sed`/`grep -v` (exit > 1) no longer `mv`s a partial file over
  `exclude`; the temporary is removed on every failure. Checked under dash
  and busybox applets.
- Tests: `git_guard::a_rewritten_exclude_keeps_its_mode_and_a_new_one_gets_gits`,
  `git_guard::an_oversized_exclude_is_refused_unread`,
  `brand_migration::project::a_rewritten_exclude_keeps_its_mode` (local +
  remote script, also asserts no temporary left in `info/`). Threat model
  gap 13 row amended (mode, cap).

**Agreed.** Not making `info/` read-only in the fence: sparse-checkout and
repack (`info/refs`) need it; host-side handle I/O is the right layer.

**Not fixed — for the lead.**
- *New, confirmed (git 2.53):* a FIFO at `.git/info/exclude` **or an
  in-tree `.gitignore`** makes host-side `git status` block forever
  (`timeout 3 git status` → 124). `commands::git::run_git` has no timeout
  that I found, so a fenced agent can hang Tabtivity's background git
  probes. Not step-5 scope (the work tree is attacker-controlled anyway);
  worth a todo + threat-model gap.
- Git dir comes from `git rev-parse --git-common-dir` and is opened by name
  (follows `.git` pointer / `commondir`). A pointer the agent controls
  could aim the write at another repo's `info/exclude` — fixed content only,
  same as before the change, and top-level `.git` / worktree pointers are
  pinned by `git_guard`. Not worse.
- Remote scripts stay test-then-act (residual already stated).
- Windows target not compile-checked here (needs the RC shim); the change
  is cfg-guarded and `write_as`'s mode args are unused-allowed there.

**Gates.** `cargo test -q --lib -- git_guard brand_migration markup_rounds
commands::git home_io`: 209 pass, 1 ignored. clippy `--all-targets -D
warnings` clean. `git diff --check` clean on touched files.
`backend:stale`: no Tabtivity process identified, Rust side not checked.

## Step 6 — implementer (#2348; gap 14)

**Origin.** Nothing recorded which phone made a rule (held prompts are
send-now rules in `agent_tasks.json`; `PhoneHolds`/`phoneHolds.ts` are
in-memory id sets). New optional `ScheduledAgentPrompt::phone_device` (the
paired device id; `skip_serializing_if`, absent = unknown origin, left
alone). `apply_upsert` keeps the stored one on every edit (like `origin`);
`validate_prompt` bounds it. Stamped headless in
`headless::{schedule_mutate (create only), prompt_mutate (send), hold_prompt}`
(new `phone: Option<&str>` param, from `Phone::device_id`), and on the
window path from a new optional `device_id` on `DesktopRequest::
{ScheduleMutate, PromptMutate, HoldPrompt, MarkupAnswer}` →
`MobileBridgeHost` (`mutateSchedule` create, `mutatePrompt` send,
`holdTabPrompt`, `answerMarkupFromPhone`) → `queuePromptForTab` /
`sendCollectedPrompt` `{ phoneDevice }` → `phone_device` on the rule. It
never crosses the browser API (`MobileSchedule` copies five fields; host test
asserts it).

**Access rule, not duplicated.** `discovery::scope_sources` extracted from
`Catalog::load_with` (the opt-in rule), `device_listed` shared with
`ResolvedProject::reaches`; new `discovery::ScopeAccess` (raw id → list).
New `mobile_control/phone_origin.rs`: `PhoneAccess` = paired ids
(`auth::read_paired_devices`) + `ScopeAccess`; unpaired → `Ok(false)`
without scopes; unreadable scopes → `Err` (unknown).

**Cancel.** `agent_tasks::cancel_phone_rules{,_in}(path, reaches)` drops rules
(and their claims) answered `Ok(false)`. Called by `phone_origin::sweep{,_in}`
from: sidecar admin `Revoke`/`ForgetAll` (off the auth lock;
`AdminContext::state_dir`), the window's `mobile_admin` (sweep + always emits
`agent-schedules-changed`, since the sidecar already swept), the window's
`set_project_mobile_access` / `set_box_mobile_access` (new `app` param),
`scheduler::run` at start. **Backstop:** `claim_locked` checks a phone rule
first: `Ok(false)` → `apply_delete` + write + log → `ClaimOutcome::Cancelled`
(window command emits changed); `Err` → refused, rule kept, logged. `claim`
now returns `ClaimOutcome`; `claim_in` still `bool`. One `eprintln!` line per
pass. No UI: revoke has no toast pattern; lists/chip drop the rows on reload.

**Tests.** `phone_origin` (7): revoke cancels only that phone's (desktop,
other phone, old rule stay), Lock down, narrowing (list + switch off), claim
backstop drops revoked/narrowed rules and still fires others + an old
field-less rule, unreadable access cancels nothing / holds back, edit keeps
the phone + bad id refused. `admin` forget-all sweeps; `headless`
`a_rule_a_phone_makes_with_no_window_names_the_phone`; `protocol` field +
older-sidecar parse; `MobileSchedulePreface.test.tsx` create stamps, update
doesn't.

**Gates.** Full `cargo test -q --no-fail-fast`: lib 3498 pass, 1 fail
(`help_mcp::tests::real_corpus_parses`, known), integration suites pass.
clippy `--all-targets -D warnings` clean. `npm run build` ok. `npm test`:
7344 pass, 1 fail (`MobileIndicator.test.tsx` multiple "Close", known).
`npm run lint`: 0 errors, 31 warnings, none in touched files. brand-check:
3 pre-existing hits only. `backend:stale`: no Tabtivity process identified,
Rust side not checked. `mobile-web/` untouched (no bundle). Never live.

**Open / for the reviewer.**
- Downgrade: `ScheduledAgentPrompt` is `deny_unknown_fields`, so a build
  older than this cannot read `agent_tasks.json` once a phone rule exists
  (as with `origin`). Same for an older window receiving `device_id`
  (`DesktopRequest` is `deny_unknown_fields`) — the sidecar is kept at the
  window's build.
- A cancelled sent collected prompt's history row stays "queued".
- Root access switched off is caught by the claim and the next sweep only
  (no hook on that settings write).
- Docs: todo #2348, threat model gap 14 + lost/stolen row,
  `docs/context/mobile_access.md` (new section, two stale statements),
  `docs/help/mobile.md` revoke paragraph, `filemap_backend.md`
  (`agent_tasks.rs`, `mobile_control/` rows).

## Step 6 — reviewer

**Verdict:** sound design, three bugs fixed, one gap left open for the lead.

**Fixed.**
- *Version skew (lead's must-check), confirmed.* The sidecar is a copy of a
  window binary, replaced only at a launch (`start_host_on_launch` →
  `launch_host`) or by Update host. A failed update keeps the newer copy
  running, so a newer sidecar can talk to an older window. That window's
  `DesktopRequest` (`deny_unknown_fields` at HEAD) fails to parse
  `device_id`, and `handle_desktop_stream` drops the stream unanswered. The
  sidecar reads EOF as "no window" (`desktop_down`), so every
  schedule/send/hold took the **headless path with the window open**. That
  path writes `phone_device` into `agent_tasks.json`, which that older
  window can then no longer read. Fix: `admin::desktop_call` now wraps
  `desktop_call_once`. When the window accepted the connection and then
  dropped it without an answer (any error except `desktop_unavailable`, the
  error for no connect or a timeout), a request carrying a `device_id` is
  asked once more without it (`without_device_id`). host.rs is untouched.
  Test `admin::tests::an_older_window_is_asked_again_without_the_phone`.
- *Lock-order deadlock.* `agent_tasks::cancel_phone_rules` built `Guard {
  _file: file_lock(..), _mutex: LOCK.lock() }`. Fields are evaluated in the
  order written, so it took the file lock before the mutex, the opposite of
  `lock()`. A window claim on another thread could then deadlock against
  the window's sweep, and these are main-thread sync commands. Fixed to take
  the mutex first. Test
  `the_phone_sweep_waits_for_the_mutex_before_taking_the_file` fails with
  the old order (checked).
- *Unreadable box/root file cancelled rules.* `scope_sources` reads
  `boxes.json` leniently (unreadable = no boxes), and `root_open` treats an
  unreadable `settings.json` as off. So a torn file *removed* every box or
  root phone rule, against the "unknown → hold back" rule. `ScopeAccess::reaches`
  now answers `Err` for a `box:` id when `boxes.json` is present but
  unparsable, and for root when `settings.json` is. A missing file still
  means none. Test `an_unreadable_box_or_root_file_holds_its_phone_rules_back`.

**Checked, fine.** `device_id` always comes from `Phone::device_id()` (the
authenticated session). `MobileScheduleInput`/`PromptMutation` are typed,
so the body cannot carry `phone_device`. TS spreads only those fields and
stamps on create only. `apply_upsert` keeps the stored value. Claim covers
the window scheduler (due, missed, `queueDuePhoneHold`), the headless
scheduler (due and missed), held prompts and markup answers (send-now
rules). `after_usage_reset` is a rule kind on the same claim. The agent
store key is the scope raw id (`mobileScope().id`: project id, `box:<id>`,
`root`) = `ScopeAccess` key. Malformed list = `Some([])` = none; absent =
all; root = all paired. Old/desktop/agent rules are untouched.
Claimed-then-revoked: typed once (inherent); the later `complete` on the
removed rule fails quietly.

**Not fixed (for the lead).**
- A phone's **Update of a desktop/agent rule** keeps the desktop origin.
  The rewritten words survive the revoke. Collected prompts a phone wrote
  and the desktop later sends are unstamped too. This is a design call:
  should a phone edit adopt the rule? Written into
  `mobile_access.md` Known gaps.
- History row stays "queued": not trivial. `agent_prompts` `RESULTS` has
  no "cancelled" pill, and a new result needs schema, UI and i18n.
- Project deleted or moved to a non-local tier, box deleted, root switch
  off: only the claim and the next sweep catch these (no eager hook). Fine.

**Docs.** `mobile_access.md`: skew paragraph rewritten (retry,
older-build refuses rather than rewrites), unreadable-file list, new
known-gap bullet.

**Gates.** `cargo test --lib -- mobile_control agent_tasks phone_origin`:
382 pass, 1 fail `git_overview::probe_reads_worktrees_branches_and_one_dirty_row`
(flaky under load, passes alone twice, unrelated). New tests pass. clippy
`--all-targets -D warnings` clean. `git diff --check` clean.
`MobileSchedulePreface.test.tsx` 3/3. No TS changed, so no build.
`backend:stale`: no Tabtivity process identified, Rust side not checked.

## Step 7 — implementer (#2349; gap 15)

**Reproduced (git 2.53, scratch repo).** A FIFO hangs `status` at:
`info/exclude`, `info/attributes`, top-level and nested `.gitignore` and
`.gitattributes`, `config`, `HEAD`, `index`, `packed-refs`. Also: `diff`
(`.gitattributes`, `info/attributes`, `config`, `HEAD`, `index`,
`packed-refs`), `diff --name-only HEAD` / `--numstat` (`info/exclude`,
attributes), `ls-files --others --exclude-standard` and `check-ignore`
(ignore files), `rev-parse` (`config`, `HEAD` only), `log` (`config`, `HEAD`,
`packed-refs`). `info/sparse-checkout` does not hang. Rust side too:
`discover_git_dir`/`repo_config_files` `read_to_string` of a `.git` pointer or
`commondir` would block on a FIFO before git ran.

**Choice: one shared helper, `services::git_bounded`.**
- `hazard(dir)`: finds the top and git dir like git (nearest `.git`, one
  `gitdir:` hop, `commondir`), `metadata` (follows links, as git does) on
  top-level `.gitignore`/`.gitattributes` and, in the git and common dir,
  `HEAD`, `index`, `config`, `config.worktree`, `packed-refs`,
  `info/exclude`, `info/attributes`, plus `commondir`. FIFO/socket/device →
  `Err("git was not run: <path> is a named pipe …")`, `eprintln!` once per
  file. A link to `/dev/null` passes. Skipped for `init`/`clone`.
- `run(&mut Command, Opts{stdin, stdout_cap, timeout, no_precheck})`:
  `process_group(0)` (unix), stdout/stderr read on threads, deadline; on
  expiry `reap_child_subtree` + `killpg(SIGKILL)` + `kill` + `wait` (no
  zombie), readers given 2 s then abandoned. Error text: "git <verb> timed out
  after N s and was stopped …". `output`, `output_within`, `BoundedOutput`
  (`.bounded_output()` drop-in for `.output()`).
- Ceilings from the verb (`verb()` skips `-c k=v`, `-C dir`, …): 2 min for
  reads and ref/metadata verbs (status, diff, show, log, ls-files, rev-parse,
  config, branch, tag, update-ref, hash-object, …), 10 min for work-tree and
  unlisted verbs (add, checkout, reset, merge, blame, …), 1 h for
  fetch/pull/push/clone/bundle/gc/… and for non-read verbs with hooks live
  (no `core.hooksPath=` pin). Test seam: thread-local `TEST_TIMEOUT` cap and
  `LAST_PID`.

**Wired.** `commands::git::run_git_as` local half (so every `run_git` /
`run_git_hooked` caller: status/dirty/file-tree polls, the git overview's
worktree/branch/dot reads, git_pull's local reads and merges, commit, …);
the config sanitizer's own `git config --file` calls; `git_repo_root`;
`hooks_dir`; `usage_stats` (log + user.email); `fs::ignored_paths_under`;
`projects` (`git_in`, `git_head_unborn`, worktree repair, scaffold commit);
`git_pull` viewer-merge `rev-parse`; `exec_trust` (3); `git_overview`
linked-worktree status; `mobile_control::files` check-ignore (stdin) and
ls-files (cap); `prompt_blame`; `git_peer` local; `brand_migration::project`;
push lane (`git()`, three `merge-base`s, `repo_rewrites_urls`);
`git_release` tag create/delete; `git_publish` local origin edits.
`markup_rounds::run` was already bounded: now reaps the subtree on expiry.
`discover_git_dir`/`repo_config_files` read the pointer/`commondir` through
`read_small_regular` (O_NONBLOCK, fstat regular, 64 KiB).

**Fail-closed fixes found on the way.** A refused/timed-out query used to be
read as "nothing there": `exec_trust::git_subjects` now adds a "git could not
be read (hooks|config)" subject (so the gated verb asks instead of an empty
list = `Ok`), and `repo_rewrites_urls` answers `true` (refuse) — otherwise a
FIFO planted for the check and removed before the push would skip it.

**Left alone.** User-initiated push/fetch/clone/`git_push_blocking`/
`git_pull` fetch keep their handling (network; the lane already uses
`run_capped`). Remote (SSH) git is unchanged. Test-only spawns, `dev_build`
(own repo), `sync.rs` `diff --no-index` on temp files, `git_fork`'s fresh
clone, `git_init`. Frontend: an errored dirty probe still shows "clean"
(`gitDirty.ts` catch, pre-existing; its fallback re-issues `git_status`,
so a hang costs two ceilings per round — `PROBES_IN_FLIGHT` keeps it to one
chain per project). A write verb killed at its ceiling can leave
`index.lock`.

**Scheduling.** Window commands run on tokio's blocking pool
(`run_off_thread`), the phone host's probes on `spawn_blocking`, each call
independent; the dirty poll dedups in flight. A per-call ceiling is enough —
no shared worker one hung repo could starve.

**Tests.** `git_bounded`: verb/ceiling table, normal repo + stdin + cap,
FIFO `info/exclude`/`.gitignore`/`.gitattributes`/`info/attributes`
refused in < 5 s (also from a subfolder), `/dev/null` link fine, FIFO
nested `.gitignore` times out and `/proc/<pid>` is gone, a `sh` grandchild
holding the pipes is killed with the tree, FIFO pointer/`commondir` never
blocks. `commands::git::a_fifo_ignore_file_makes_the_status_polls_fail_fast_not_hang`
(`git_status_probe` + `git_file_statuses_blocking`, both cases).
`exec_trust::an_unreadable_repo_is_a_subject_not_nothing`; push-lane
rewrite test extended (FIFO → rewrite, removed → none).

**Gates.** Full `cargo test -q --no-fail-fast`: lib 3509 pass, 1 fail
(`help_mcp::tests::real_corpus_parses`, known), integration suites pass.
`git_overview::probe_reads_worktrees_branches_and_one_dirty_row` 5/5 alone.
clippy `--all-targets -D warnings` clean. Windows clippy (`--lib --tests`,
shims): no diagnostic in touched files. `git diff --check` clean;
brand-check: one pre-existing hit (`mobile-web/…/inboxRefs.ts`).
`backend:stale`: no Tabtivity process identified, Rust side not checked.
No frontend change. Never live.

**For the reviewer.** `process_group(0)` on read/write git calls: a git that
wants a tty prompt (none of these should) would get SIGTTIN when Tabtivity
runs from a terminal. The hazard pre-check also refuses `rev-parse`-only
calls when e.g. `.gitignore` is a FIFO (git itself would not hang there) —
deliberate, deterministic, fails closed.

## Step 7 — reviewer

**Verdict: sound; three fixes made, nothing blocking.**

**Runner checked.** Both streams are read on threads, so a big output can't
fill a pipe and deadlock. The stdout cap stops git. On expiry it walks the
subtree first (catches a `setsid`'d descendant still in the tree), then
`killpg` and `kill`, then `wait`, so no zombie is left. Readers get 2 s and
are then abandoned (a double-forked escapee can't hold the call). Windows:
no group, but `reap_child_subtree` walks the tree with `TerminateProcess`
and the call is still bounded. macOS: `sysstat` walks nothing there, so only
the group is killed; the 2 s reader cut still bounds the call. stdin is
`Stdio::null()` for every run except check-ignore's fed pipe. No bounded run
does network transport (fetch/push/clone stay on their own paths with
`GIT_TERMINAL_PROMPT=0`). So `process_group(0)` + SIGTTIN can only bite a
hook or pinentry that opens `/dev/tty` when the app was started from a
terminal (dev only). Before this step that hung forever; now it stops at the
ceiling. OK as is.
`hazard()`: worktree/submodule `.git` files, a missing `commondir`, links to
`/dev/null` and a `.gitignore` folder all pass. `core.excludesFile` is not
checked, but the timeout covers it. `exec_trust`: only Err (spawn failure,
refusal, timeout) adds the subject; a non-zero exit does not. Its bytes are
stable error text, so there is no re-ask loop, and approving it can't pass
real hooks later (the fingerprint changes once git reads again).
`repo_rewrites_urls`: exit 1 (no match) is still "no rewrite".

**Fixed.**
- `stores/gitDirty.ts`: an errored probe now drops the project's entry
  instead of writing "clean". It retries the old two-command spelling only
  for "command … not found", so a timed-out probe no longer costs two
  ceilings. Test: `GitDirtyState.test.ts` "drops the reading…".
- `git_bounded::LONG_VERBS`: checkout/switch/restore/reset/merge/rebase/
  cherry-pick/revert/stash/worktree/am/read-tree/checkout-index/
  sparse-checkout now get 1 h. The user's global `filter.lfs.smudge` survives
  the repo-config sanitizer and downloads on checkout, and a mutating verb
  killed half-way leaves a half-written tree plus `index.lock`. `add`,
  `commit` (hooks off) and `blame` stay at 10 min. The verb table test is
  extended.
- Unbounded spawns that were left: `detect_git_providers` (`git -C dir remote
  get-url`, a sequential loop over every project on a window command) is now
  bounded at 15 s and runs in the folder, so the pre-check sees it.
  `git_init::{ok,out}` (Publish's `ensure_default_branch` on an existing
  repo) is bounded too.
- Docs: gap 15 row (ceilings, the dot, the `index.lock` residual) and the
  #2349 todo entry.

**Listed, not fixed.**
- `index.lock`: nothing cleans stale locks. Background reads take none
  (`GIT_OPTIONAL_LOCKS=0`). After a killed write, git's own error names the
  file. Removing it automatically is unsafe while another git may run.
- The pill paints a missing entry as `git-clean` (`ProjectPill.tsx:2845`), so
  "unknown" and "clean" still look the same. A distinct mark is a UI design
  call.
- `status` at 2 min: a giant untracked tree on a cold or network FS could hit
  it. The poll then shows no dot (now honest) instead of a slow one.
- `ProjectFilesView` turns an errored `git_unpushed_commits` into `[]`, so the
  dot shows "clean" instead of "unpushed". Minor, pre-existing.

**Gates.** `cargo test --lib`: git_bounded 6, git_init 5, commands::git 93,
exec_trust 10, git_push 18, git_peer 67, git_release 7,
mobile_control::files 15, brand_migration 76, usage_stats 44,
commands::projects 93, git_pull 4: all pass. clippy `--all-targets -D
warnings` clean. `npm run build` clean. vitest GitDirtyState, MobileGitDots
and ProjectHoverCardGitState: 20/20 pass. `npm run lint`: 0 errors, 31
warnings, none in the touched files. `git diff --check` clean. brand-check:
the one known hit (`inboxRefs.ts`). `backend:stale`: no Tabtivity process
identified, so the Rust side was not checked. Never live.

## Follow-ups 8–10 — implementer

**Step 8 (#2348, a phone's edit takes a rule over).**
- `agent_tasks::apply_upsert`: an edit that names a phone (`phone_device:
  Some`) stamps it; one that names none (desktop, agent, older sidecar)
  keeps the stored stamp. Schema doc updated.
- Collected prompts: new `ProjectAgentPrompt::phone_device` (persisted,
  optional; persisted struct tolerates unknown fields, so older builds read
  it) and `ProjectAgentPromptInput::phone_device` (`Some` stamps, `None`
  keeps), validated as an id. `MobileCollectedPrompt` copies its own fields,
  so it never reaches the browser (host test asserts it).
- Headless: `schedule_mutate` Update stamps the phone; `prompt_mutate`
  Create/Update stamp it, Send names the sending phone else the prompt's;
  `edit_held_prompt` gained `phone: Option<&str>` (stamps, else keeps).
- Window: `DesktopRequest::EditHeldPrompt.device_id` (optional; added to
  `admin::without_device_id` so an older window is retried without it);
  `MobileBridgeHost`: `mutateSchedule` stamps on update too, `mutatePrompt`
  passes `phoneDevice` to `store.upsert` (new `phoneDevice` → `phone_device`),
  `editHeldTabPrompt` stamps; `sendCollectedPrompt` uses
  `options.phoneDevice ?? prompt.phone_device`, so a desktop send (Prompt
  chart, after-links) of a phone-written prompt names the phone.
- Not covered (documented): a schedule the desktop composes in the schedule
  dialog from a phone-written prompt is the desktop's.
- Tests: `phone_origin::a_phone_edit_takes_a_rule_over_and_its_revoke_cancels_it`,
  `headless::a_rule_a_phone_makes_with_no_window_names_the_phone` (extended:
  update by another phone, desktop rule update, held edit of a desktop hold,
  desktop prompt edited by phone then sent with no phone),
  `agent_prompts::a_phone_edit_takes_a_prompt_over_and_a_desktop_edit_keeps_it`,
  `admin::a_held_edit_is_retried_without_the_phone`, protocol held test
  extended, `MobileSchedulePreface.test.tsx` (schedule update stamps, unnamed
  update doesn't; held edit; prompt edit; desktop send carries/omits).

**Step 9 (#2349, "unknown" git mark).** `GitDirtyState` gains `"unknown"`,
written by an errored probe. Pill: `.pill-folder-icon.git-unknown` (grey
#8b949e like `git-broken`, hollow: `svg { fill: none; stroke }`, nothing
animated). The "tooltip" is the hover-card line `pill.gitUnknown` "Git status
unavailable" (+ `UntestedTag`): commit 303fc164 moved every git-state
explanation from a native `title` on the icon into the card, and
`ProjectHoverCardGitState` asserts the icon has no title, so no `title` was
added. The phone gets no dot for unknown (`MobileGitDot` excludes it).
`ProjectFilesView`: a failed `git_unpushed_commits` is `null`, not `[]` —
the bar keeps its last list, no snapshot is written, and a clean-looking
pill is left to the switcher's probe. Tests: `GitDirtyState`,
`ProjectHoverCardGitState` (card line + pill class), `MobileGitDots`,
`GitBarRefresh` ("never turns a failed unpushed read into a clean dot").

**Step 10 (#2343, window for input by reference).**
`api_prices::context_window(provider, model)` (Claude API model table via
the claude-api skill, cached 2026-09-25: 1M current models, Sonnet 4/4.5 1M
with the beta; 200K Haiku 4.5, Opus 4.5/4.1/4, 3.5 Haiku. Gemini model pages
fetched 2026-10-05: 1,048,576 for 3.8 Flash, 3.5 Flash, 3.1 Pro, 2.5 Pro —
taken for every Gemini model; image/TTS/embedding hold less, an overcount).
Unknown → the largest. `api_meter::names_input_by_reference` (serde visitor,
every key and duplicate seen, unparseable = yes): Anthropic `type` value
`url`/`file`/`web_fetch*`/`web_search*` or a `file_id` key; Gemini keys
`fileData`, `fileUri`, `cachedContent`, `urlContext`, `fileSearch`,
`googleSearch(Retrieval)`, `googleMaps`, `enterpriseWebSearch`, `retrieval`
(case and `_` folded). `worst_case` only: input = max(body/3, window); the
cut-off charge is unchanged. The existing grounding worst-case expectation
was updated (a grounding tool now holds the window). Tests:
`api_meter::input_by_reference_is_found_however_the_body_spells_it`,
`input_by_reference_holds_the_models_whole_window` (Opus 5.5 1M, Haiku
200K, inline unchanged, Gemini 3.1 Pro long-tier), `api_prices` window table.
Residual: web searches, >10 grounding queries, a server tool re-reading its
results over iterations, code-execution/MCP results.

**Docs.** todo #2343/#2348/#2349 follow-up lines; threat model gaps 8, 9,
14, 15, Agent API proxy, lost/stolen and Background git rows;
`docs/context/mobile_access.md` (new paragraph + Known gap rewritten);
`docs/context/agent_authority.md` (reservation sentence);
`docs/help/mobile.md` (revoke paragraph); `filemap_backend.md` api rows.

**Gates.** `cargo test -q --no-fail-fast`: 3689 pass, 3 ignored (14
suites). clippy `--all-targets -D warnings`: clean. `npm run build`: ok.
`npm test`: 7358 pass, 1 fail — `MobileIndicator.test.tsx` "multiple Close
buttons", the known pre-existing one. `npm run lint`: 0 errors, 31 warnings,
none in touched lines. brand-check: the 3 known hits. `git diff --check`
clean. `mobile-web/` untouched (no bundle). `backend:stale`: no Tabtivity
process identified, sidecar serves the built bundle, Rust side not checked.
Never live.

**Already committed by someone else — HEAD does not build alone.** Commit
23286344 ("Count working, waiting and done agent tabs…", another session)
swept in these hunks of mine: `mobile_control/host.rs` (`edit_held_prompt`
handler: `device_id: Some(phone.device_id()…)` and the 6-arg
`headless::edit_held_prompt` call; the `phone_device:
Some("device-that-wrote-it")` line + comment in
`successful_prompt_response_omits_internal_target`), `"pill.gitUnknown"` in
`src/lib/i18n.ts` and the four dicts, and the `"pill.gitUnknown"` row in
`src/lib/untested.ts`. Their definitions are still uncommitted, so HEAD
fails to compile (and `UntestedRegistry` would flag the row) until the files
below land.

**Files changed (uncommitted, all hunks mine unless noted).**
- `src-tauri/src/schema/agent_prompts.rs`, `src-tauri/src/schema/agent_tasks.rs`
- `src-tauri/src/services/agent_prompts.rs`, `agent_tasks.rs`, `api_meter.rs`, `api_prices.rs`
- `src-tauri/src/services/mobile_control/{admin,headless,phone_origin,protocol}.rs`
  (headless.rs: every hunk is mine, incl. the doc comments at ~1098 and ~1162)
- `src/components/mobile/MobileBridgeHost.tsx`, `src/stores/agents/agentPrompts.ts`,
  `src/stores/gitDirty.ts`, `src/lib/mobileGitDots.ts`,
  `src/components/projects/ProjectHoverCard.tsx`, `src/components/files/ProjectFilesView.tsx`,
  `src/styles/apps.css`, `src/styles/projects-tabs.css`
- Tests: `src/__tests__/mobile/MobileSchedulePreface.test.tsx`,
  `src/__tests__/git/GitDirtyState.test.ts`, `src/__tests__/mobile/MobileGitDots.test.ts`,
  `src/__tests__/projects/ProjectHoverCardGitState.test.tsx`, `src/__tests__/shell/GitBarRefresh.test.tsx`
- Docs: `todo/group-o-security.md`, `docs/threat_model.md`,
  `docs/context/mobile_access.md`, `docs/context/agent_authority.md`,
  `docs/help/mobile.md`, this handoff.
- **Mixed:** `docs/filemap_backend.md` — mine are the `api_meter.rs` and
  `api_prices.rs` rows (lines 119–120); the `mobile_control/` row (line 88,
  pty_bridge wording) is another session's.
- Not mine: `docs/threat_recheck_fixes_plan.md` (lead),
  `src-tauri/src/services/mobile_control/pty_bridge.rs`, `docs/overlay_agent_plan.md`.
