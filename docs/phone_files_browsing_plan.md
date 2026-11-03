# Phone / iPad file browsing — bugs and small improvements plan

> **Status (2026-11-03): batch A committed (`06905950`); batch B (B9, S1, S2)
> implemented, gates green, not committed; neither run on a phone or iPad.
> Batch C not started.**
>
> Batch B as built: S1 nonce = HMAC-SHA256 under its own HKDF label
> (`path-token nonce v1`) over length-prefixed raw id + rel; S2 route
> `GET …/files/entry?name=<leaf>[&dir=<token>][&on=host]` → `{ entry }`, the
> phone's `lookUpProjectFile` / `lookUpFileRow` (`api.ts`) for favorites,
> recents, the library's and project cards' Reload and `refreshProjectFile`;
> an older desktop's bodiless 404/405 falls back to the folder listing. B9:
> `still_proven` after `read_on` (lstat + realpath again) — no fake-SFTP test
> exists, so it is covered only by review.
> Line numbers are from `develop` at `48f4b5b9` and will drift; grep for the
> named symbol before acting on one. Todo: **31cp** in
> `todo/group-h-crossplatform.md`.
>
> Batch A as built, where it differs from the text below:
> - B1: Escape over a viewer goes through `goBack()` in the library, the
>   Favorites page, the project screen's gallery viewer and the chat's
>   outbox viewer (the last two had the same bug).
> - B2/B3: a non-text file over 24 MB (`MAX_VIEW_FILE` in `api.ts`) shows a
>   "too large" card with no Save, Share or Mark up, so it is never fetched;
>   `failureKey` maps the extra codes, including `timeout`/`offline`.
> - B4: scroll offsets live in a module map (`OFFSETS`), so they also survive
>   closing and reopening the library within one app session, not a reload.
>   Covers pause through `holdCovers()` (`ThumbQueue.hold`).
> - B7: `useModalFocus` (`mobile-web/src/modalFocus.ts`) does nothing when a
>   text field opened the sheet, so the phone's keyboard is not put away.
> - Tests: `src/__tests__/mobile/MobileFilesLibraryViewer.test.tsx`, plus a
>   queue-hold case in `MobileThumbs.test.ts`. The "Esc keeps an open markup
>   note" path itself is not covered by a test (MarkupView needs the pdf.js
>   frame); it rests on Escape now taking the same route as Back.

Two read-only reviews went over the phone PWA's files library. One covered the
UI and interaction (`mobile-web/src/components/FilesLibrary.tsx`,
`ProjectFiles.tsx`, `filesPlace.ts`, `FavoritesPage.tsx`, `OutboxViewer.tsx`,
`libraryView.ts`, `thumbs.ts`, `backStack.ts`). The other covered data, API
and backend (`mobile-web/src/api.ts`,
`src-tauri/src/services/mobile_control/{files,host_files,uploads,outbox,host}.rs`).
This plan merges them.

- **Re-checked against the code after the merge:** B1, B2, B4, B5 and the
  `failureKey` half of B3. Each is marked "verified" below.
- **Everything else** rests on the reviewers' citations and must be verified
  before it is acted on.
- **Not run:** nothing was tried on a phone or iPad.

Related: `docs/done/mobile_files_library_plan.md` (the library's fixed
decisions; decision 2 "read-only apart from Upload here" and decision 4 "sorting
happens on the phone" still stand here), `docs/context/mobile_sidecar.md`,
`docs/context/mobile_access.md`.

**Order:** phase 1 (bugs), then phase 2 (small items), each in the batches
under *Organisation*. Phase 3 is listed only so nothing is lost: none of it
starts without the user picking it, and two of its items reverse a fixed
decision.

**Constraints every item keeps:**
- `services::mobile_control` lets no raw project id, path, command or tmux
  target cross the browser API. The phone holds only sealed tokens and the
  folder names it was shown.
- Anything inside a project folder is attacker-controlled.
- All text goes through `mobile.files.*` i18n keys, in every locale the phone
  ships.
- A host-side (`?on=host`) change must also work over SFTP (`host_files.rs`),
  or say plainly that it is local-only.

---

## Phase 1 — bugs

### B1. Esc closes markup without Done (verified)
**What happens.**
- `FilesLibrary.tsx:527-540` listens for `keydown` on the window. While a file
  is open, any `Escape` calls `setFileOpen(null)`.
- When that file is a PDF, or is being marked up, the viewer is a `MarkupView`
  (`OutboxViewer.tsx:370-393`).
- `MarkupView`'s Done (`MarkupView.tsx:1418-1430`, and Back through
  `useBackLayer(... done)`) saves an open note with `saveLayer` before it
  closes. Esc unmounts the view without running it.

**Effect.** With an iPad keyboard, Esc while a note is open throws the note's
text away. That includes Esc pressed inside the note field itself. Marks that
were already committed are saved by the effect at `MarkupView.tsx:768`;
confirm that this covers a mark placed just before the Esc.

**Fix.** While `fileOpen`, the library's Esc calls `goBack()` (`backStack.ts`).
That runs the top layer's own Back: `MarkupView`'s Done, or the viewer's close.
The handler skips events that are `defaultPrevented` or `isComposing` (an IME
in a note). It still handles a sheet, then a search, then up.

**Also.** The `FavoritesPage` viewer (`FavoritesPage.tsx:~150`) has no Esc at
all. Give it the same `goBack()` handler.

**Tests.** Extend the library tests: Esc with `MarkupView` open and a note
typed keeps the note (spy on `saveLayer`, or the layer store); Esc in
Favorites' viewer closes it.

### B2. Blank viewer for other file types (verified)
**What happens.** `OutboxViewer.tsx:421-430` renders `isText ? … : isImage ?
… : null`. A `.docx`, `.zip`, `.csv` sniffed as binary, or a video opens to a
header (Save / Share) over an empty screen.

**Fix.** A "no preview" card in place of `null`: the kind glyph (`glyphOf`,
`libraryView.ts`), the name, size and date, a sentence saying the phone can't
show this kind, and the existing Save / Share / Open outside actions as big
buttons. New i18n keys, all locales.

**Tests.** The viewer renders the card for an `application/octet-stream` file.

### B3. Some refusals show as "Error" or raw JSON (partly verified)
**What happens.**
- `failureKey` (`FilesLibrary.tsx:137`, verified) maps only `files_off`,
  `file_not_found`, `host_offline` and `project_not_found`.
- The sidecar can also answer `file_too_large` (413), `project_unavailable`,
  `files_unavailable`, `query_too_long` and `read_failed` (`host.rs`
  7424–7900, unverified). These all show the generic "Error".
- Reviewer, unverified: a PDF over the 24 MiB cap opened with `openOutside`
  shows the sidecar's JSON body in the browser.

**Fix.**
- Map each of those codes to a sentence. Reuse keys that already exist where
  they fit, as `UPLOAD_FAILURES` does (`mobile.sendToDesktop.tooLarge`,
  `mobile.projectInbox.unavailable`).
- For `openOutside`, check the size against the cap before opening, and say
  "too large to open on the phone" instead.

**Tests.** `failureKey` table test.

### B4. The list jumps back to the top (verified)
**What happens.**
- Opening a file returns the viewer *instead of* the library
  (`FilesLibrary.tsx:656-662`), so closing it rebuilds the list at
  `scrollTop 0`.
- Going up a folder also starts at the top. The file has no `scrollTop`
  handling at all.

**Fix.**
- Keep the library mounted and render `OutboxViewer` as an overlay sibling.
  It is already `position:fixed; inset:0`.
- Make the library behind it `inert` and `aria-hidden`, so its keys, focus
  and swipe can't be reached.
- The swipe effect (`:542-551`) and the Esc effect keep their `fileOpen`
  guards.
- Pause thumbnail work (`useThumb`) while it is covered.
- Keep a per-folder `scrollTop` map in component state, keyed by the folder's
  place path (names; tokens are not stable, see S1). Restore it on going up
  and on the remembered trail reopening.

**Watch out.**
- The comment at `:556` relies on `fileOpen` remounting the viewer by `key`;
  keep that key.
- `useBackLayer` order: the viewer's layer must still be on top of the
  library's.

**Tests.** Open, close and scroll restore (jsdom: set `scrollTop` and assert
it after close); up restores the parent's offset.

### B5. "Newest first" can be wrong in folders with over 500 entries (verified)
**What happens.** `files::list_with_budget` (`files.rs:669-674`) sorts folders
first, then by name, and truncates to `MAX_ENTRIES` (500) before the phone
sorts. The reviewer reports `host_files::kept_rows` does the same. So in a
folder with more than 500 entries, "Last edited" and "Created" sort only the
first 500 by name.

**Fix now (S).** When a listing is `truncated` and the sort key isn't name, the
truncation note says so: "Sorted among the first 500 by name — search to find
others".

**Full fix.** Sort on the desktop, with a cursor. That reverses decision 4, so
it is phase 3 (L1).

### B6. Favorites groups reorder while loading
`FavoritesPage.tsx:~77` sorts groups by `labelOf`, which changes from the
placeholder to the project's name as each `GET /projects/{id}` lands. Sort by
a key that doesn't change while loading: the order `readFavoritePlaces`
returns, then the name once every name is in. Alternatively, hold the order
until all lookups settle. Test: groups keep their order across a late name.

### B7. Menus don't move keyboard focus
`OptionSheet.tsx` (and the library's view and colour sheets) are
`role="dialog" aria-modal` but don't move focus in, keep Tab inside, or give
focus back on close. The list behind them isn't `inert`, so VoiceOver and a
keyboard can reach it.

**Fix in the shared sheet.**
- Focus the first action on open.
- Keep Tab inside the sheet.
- Restore the opener's focus on close.
- Make the content behind it `inert` while it is open.

**Tests.** Focus lands in the sheet and returns to the opener.

### B8. iOS edge swipe may go up two folders — check on a device first
`installFocusSwipe` with `leftEdge: true` (`FilesLibrary.tsx:547-550`) goes up
a folder. In a Safari tab, the system edge swipe can also pop history, which
`backStack.ts` turns into another "up". Whether iOS cancels the touch stream
when it takes the gesture is unknown.

**Step 1.** A manual check in Safari and in the installed PWA (31cp box).
**Step 2, only if it doubles.** Ignore the library's own swipe when it starts
within about 20 px of the left edge on iOS (`platform.ts` already detects iOS
and iPadOS), and let the system Back do the work.

### B9. Host-side symlink race (low)
`host_files.rs` `read_on` (and `sniff`) proves a path with `canonicalize`
(`:263`), then opens it by path later (`~:400`). Between the two, a symlink
swap on the host reads any file the ssh user can read, up to 24 MiB. The code
comment accepts this.

**Cheap hardening.** `canonicalize` again after the read and drop the bytes,
with `file_changed`, if the result differs. Rust test with a fake SFTP.

---

## Phase 2 — small items

### S1. Stable file tokens (backend, S)
**What happens.** `files::seal` (`files.rs:168-180`) draws a random nonce on
every seal, and the test at `:996` asserts a fresh nonce. Every listing
therefore hands out new tokens.

**Effect.** The phone keys thumbnails, favorites, recents and colours by
names, and re-lists a whole folder to reopen one saved file. The raw URL is
never the same twice, so nothing can be cached.

**Fix.**
- Make the nonce synthetic: `HMAC-SHA256(nonce_key, raw_id || 0 || rel)[..24]`,
  where `nonce_key` comes from a separate HKDF label off `host.key`, not the
  AEAD key.
- The same path in the same project and side then always gives the same
  token. It reveals only "same path", which the phone already knows.
- `unseal` is unchanged, so old tokens (favorites, trails) still open.
- Rotating `host.key` still invalidates them, as today.
- Flip the test to "same path gives same token; different project or path
  gives a different one".

**Phone side.** Nothing has to change: name keys keep working.
- Check every place that uses a token as a React `key` or a change signal.
  `fileOpen.ref` is the viewer's key, and Reload relies on a fresh entry
  replacing it.
- Also check `refreshProjectFile`'s callers.

### S2. One-file lookup route (both, S)
**New route.** `GET /api/v1/projects/{id}/files/entry?dir=<token>&name=<leaf>`
returns one sealed row (`kind`, `size`, `modified`, `created`) or
`file_not_found`.
- Local side: the existing `files::entry`.
- Host side: one `canonicalize` plus stat plus sniff, the same as a listing
  row.
- Behind `files_scope`, like the other routes. `name` must pass
  `valid_segment`.

**Phone.** It replaces the whole-folder re-list in:
- `lookUpSaved` (`FilesLibrary.tsx:~205`), used by favorites and recents;
- Mark up's `refresh` (`:556`);
- `refreshProjectFile` (`api.ts:1563`), used by the project-screen file cards.

An older host answers 404: fall back to the re-list.

**Command class.** None; it is a sidecar route, not a Tauri command.
**Tests.** Rust route tests; phone fallback test.

### S3. Refresh (phone, S)
**What happens.** The listing effect depends only on `[projectId, here.token,
reload, side]` (`FilesLibrary.tsx:~476`), so files an agent writes never
appear while the library is open.

**Fix.**
- Add **Refresh** to the ⋯ view sheet.
- Re-list when the page becomes visible again (`visibilitychange`) and when
  the viewer closes.
- No timer: a listing opens up to 500 files to sniff, and on the host side
  goes over SFTP.
- Replace rows in place (keyed by name) so the list doesn't flicker, and keep
  the scroll position (B4).

### S4. Path bar (phone and iPad, S–M)
Under the head, add a row of crumbs that scrolls sideways (root › … › current),
auto-scrolled to the end. It shows the same crumbs as the path `OptionSheet`
(`:849`).
- Tapping a crumb calls `setTrail(trail.slice(0, i + 1))`.
- The head's ‹ and title stay.
- On a remote project the root crumb carries the side's label.
- One or two i18n keys (the bar's `aria-label`).

### S5. Wide screens, first step (iPad, S)
The stylesheet has no width rules for the library or its sheets.
- At `min-width: 700px`, centre sheets and cap them at 560 px
  (`.option-sheet`, `style.css:~1332`).
- At `min-width: 900px`:
  - grid tiles `minmax(132px, 1fr)` (from 104 px; `style.css:~1472`);
  - list rows capped at about 900 px and centred;
  - the favorites strip's tiles grow with the grid.
- The up-swipe zone becomes `min(1/3 of the width, 120px)` (`UP_SWIPE_ZONE`).
  On an iPad a third is about 450 px.

The split view (folder pane plus preview pane) is phase 3 (L4).

### S6. Touch targets and long-press (phone, S)
- Tile ▾ goes from 30×30 px to a 44×44 hit area (padding, not a bigger glyph);
  the head's ‹ and ⋯ from 36 px to 44 px (`style.css:~1458-1486`).
- A long-press (and `contextmenu`, which an iPad pointer's right-click sends)
  on a tile or row opens its item sheet. Reuse the long-press helper
  `MessageMenu.tsx:~144` uses rather than writing a second one.

### S7. Search (both, S each)
- **a. Recents without focusing the box.** Show a "Recent" link under the
  search box at the root. Today recents show only while the empty box is
  focused (`:~382`).
- **b. This folder only.** Add a toggle chip that passes
  `dir=<current token>` to `files/search`. The sidecar unseals it and filters
  candidates by that path prefix. Old hosts ignore the parameter: show the
  chip only when the listing says the host supports it, or filter the hits
  on the phone by their trail.
- **c. Include git-ignored files.** Add an opt-in chip (`ignored=1`). In a git
  repo, search uses `ls-files --exclude-standard`, so `build/`, `out/` and
  `dist/`, where generated PDFs live, are never searched. With the chip on,
  search walks the folder (`walked_paths`, capped at 50k entries). The "skips
  git-ignored files" hint from 31cn points at the chip.

### S8. Large-folder rendering (phone, S)
Add `content-visibility: auto; contain-intrinsic-size: …` on `.files-tile` and
`.files-list li`. Check that the thumbnail IntersectionObserver still fires.
WebKit treats skipped content as not intersecting until it is close.

### S9. Name sort in the app's language (phone, S)
`libraryView.ts:~74` builds `Intl.Collator(undefined, …)`. Use the phone's app
language (as `stampLabel` does) so the name order matches the picker.

---

## Phase 3 — later, each needs the user's go-ahead

Listed so the reviews aren't lost. None is in scope for phases 1–2.

| id | What | Size | Note |
|---|---|---|---|
| L1 | Server-side sort plus a sealed `after=` cursor; sort before truncating; sniff only the kept rows | M | Reverses decision 4; real fix for B5 |
| L2 | Raw route: stream, answer `Range` with 206, `ETag` (`size-mtime-ino`) plus `private, no-cache` | M | Removes the 24 MiB view cap; needs S1 for caching. `inbox_file`'s cache policy is the precedent |
| L3 | More file types by magic bytes (HEIC/AVIF, mp4/mov/webm, mp3/m4a/wav/ogg); `<video>`/`<audio>` in the viewer; Office files as download-only | S–M | Never by extension; SVG, HTML and JS stay inert `text/plain` |
| L4 | iPad split view: folder pane plus a preview pane; `OutboxViewer` rendered in place | L | Builds on B4 and S5 |
| L5 | iPad keyboard: `/` and Cmd-F for search, arrow keys and Enter over tiles, Cmd-↑ for up, Space for preview; `:hover`/`:focus-visible` styles | M | |
| L6 | Drag-and-drop upload from Files.app or Finder onto the list | S–M | Behind `project_uploads`, local side only |
| L7 | Multi-select (long-press, then Share, Favorite or Mark up on several) | M | |
| L8 | Remote listing speed: type host rows by file extension (display hint only; `raw` still sniffs), cache the canonical root briefly | M | |
| L9 | Search speed: cache candidates for about 5–10 s per project, one search in flight per phone; match on paths; content search through hardened `git grep` | M | |
| L10 | New folder; download a folder as a zip (streamed, capped); streamed uploads above 24 MiB | S / M / M | New folder fits decision 2's "add-only" |
| L11 | Rename/move inside a folder behind a new off-by-default switch | M | Reverses decision 2 |
| L12 | A deadline on local listings (a stalled network mount blocks a blocking thread forever) | S | |

Delete and lasting share links were weighed and are not planned. A lasting
link breaks the session model; the short-lived `open-ticket` already covers
"open elsewhere".

---

## Organisation (for when implementation is asked for)

| Batch | Items | Side | Notes |
|---|---|---|---|
| A | B1, B2, B3, B4, B6, B7 | phone | One reviewer pass; B4 and B1 both touch the viewer's mounting, so they go together |
| B | B9, S1, S2 (with phone fallback) | backend + phone | Needs `npm run backend:stale` and a dev build to reach the phone |
| C | B5 note, S3–S9 | phone; S7b/c also backend | S3 builds on B4 (scroll kept on refresh) |

## Gates and verification

**Gates:** `scripts/gates.sh` for what each batch touches.
- Batch A and C: `npm run build` (the mobile bundle) and `npm test`.
- Batch B: also `cargo test --workspace`, the daemon build line, clippy
  (all three), and `npm run backend:stale`.

**Live run.** Never run live by the implementer. The user checks on a phone
and an iPad after a dev build, through 31cp's 🖐️ boxes:
- Esc with a note open keeps the note;
- a `.docx` opens to the no-preview card;
- the list keeps its place after a file;
- the folder-of-600 note;
- Favorites order;
- VoiceOver in a sheet;
- the iOS edge swipe (B8);
- a favorite reopens without a folder re-list (S2), checked in the sidecar log;
- Refresh shows an agent's new file;
- the path bar;
- iPad landscape sheet width and tile size;
- long-press;
- search chips.
