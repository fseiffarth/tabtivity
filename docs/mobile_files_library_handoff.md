# Phone files library — handoff

Plan: `docs/mobile_files_library_plan.md`. Each agent edits only its own
section below (absolute path in the main checkout).

## A1 — backend folder item counts (worktree `.claude/worktrees/files-lib-a1`, branch `files-lib-a1`)

**Commit:** `b1e879a9` feat(mobile): folder rows in the phone's file listing carry an item count (branch `files-lib-a1`, not pushed).

**What changed**
- `files.rs`: `Entry.items: Option<u32>` (`skip_serializing_if = None`). `list` = `list_with_budget(…, ITEM_SCAN_BUDGET)`; each folder row opens the child once (`dir.child_dir`), counts it with `item_count`, then takes its metadata from the same handle (so the counted folder is the one whose times are shown). `entry`, `dir_entry` (search hits) set `items: None`.
- `ProjectDir::each_entry(visit -> ControlFlow)` added on Unix (`files.rs`) and Windows (`files_windows.rs`): the existing `readdir` / `GetFileInformationByHandleEx` loops, stopping when `visit` breaks; `entries()` is now built on it (unchanged behaviour for outbox/inbox/uploads). Links/junctions are dropped there exactly as before.
- `mobile-web/src/api.ts`: `ProjectFileEntry.items?: number`, doc comment: 501 means "500+", missing = unknown/older host, never render as 0.
- `host.rs` route test `the_file_browser_is_off_by_default_and_reads_by_sealed_token_only` asserts the `src` folder row carries `items: 1`.
- `docs/filemap_backend.md`: one clause in the `mobile_control/` row's `files.rs` part.

**Choices**
- Budget `ITEM_SCAN_BUDGET = 20_000` names per listing, charged per name *read* (hidden names, and `.`/`..` on Unix, cost budget too — that is the real I/O). Spent in display order (folders first, by name), so the top folders get counts first. Once 0, remaining folders are not even opened for counting (they still list, with no `items`).
- Cap: counting stops at the `MAX_ENTRIES + 1`th valid name → `items = 501`, the phone shows "500+". A folder whose count the budget cut mid-scan gets `None` (never a partial number). An empty folder is `Some(0)` (a real count, may show "0 items"); only `None` must show nothing.
- Counted = names passing `valid_segment` among folders + regular files from `entries()`; a file that later fails `sniff_opened` in its own listing would still be counted (edge case, not worth a sniff per child).

**Gates** (worktree; `CARGO_TARGET_DIR=/tmp/claude-1000/files-lib-target`, `CARGO_INCREMENTAL=0`): `scripts/gates.sh` selected and passed all 10: brand, whitespace, lint-fe, clippy (tabtivity + app-serverd, all targets), clippy-dlib, clippy-dmn, build, vitest `--changed`, test, test-dlib. Counts: `cargo test -p tabtivity -p app-serverd` → 4052 passed / 4 ignored (lib) + 144 + 29 + 1; daemon build `--no-default-features --lib --test server_secrets` → 3951 passed / 4 ignored + 1. `files.rs` alone: 18 passed on Linux (3 new tests + link assertion added to the Unix link test; the Windows junction test gained two `items` assertions — compiled, not run).

**Cross-checks:** Windows msvc clippy (`--manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -D warnings`, rc/lib shims) clean; `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` clean; `cargo check --workspace --all-targets --target aarch64-apple-darwin` (ci-local's check-only cc/ar stand-ins) clean. Windows/macOS tests not run (no host).

**Gotchas**
- `~/.cargo/registry` is read-only in the fence and lacks `rustls-0.23.46` (Cargo.lock wants it): use a writable `CARGO_HOME`. I copied `.claude/worktrees/cargo-home-deps-rust` to `.claude/worktrees/cargo-home-files-lib` (1.1 GB, outside every worktree; delete when the run is done).
- The post-commit hook printed "EMBEDDED MOBILE PWA IS STALE" for the running sidecar — informational, nothing done. `npm run backend:stale` not run (per instructions); the running window lacks this backend change until a rebuild.

## A2 — library screen, view model, navigation, wiring (worktree `.claude/worktrees/files-lib-a2`, branch `files-lib-a2`)

Done, one commit: **`cb8bd545`** `feat(mobile): full-screen files library with grid/list, sort and path menu` (on top of `69206ebc`). Not run live.

What changed
- `mobile-web/src/components/FilesLibrary.tsx` (new): the full-screen library. The listing, search, Upload here + Undo, scaffold/gitignored sections, the viewer (`markup`/`showTab`/`linked`, `refresh`), the remembered trail with step-back, and Escape all moved here from `ProjectFiles.tsx` (moved, not copied). Head: `‹ parent` (at the root `‹ Back`, aria "Close the files", calls `onClose`), title button → path menu (`OptionSheet`, titled "Folders", root…current with the current ticked; a pick slices the trail), `⋯` → view menu (custom sheet built from `.option-sheet` / `.notifications-group` / `.option-list` rows, the same classes `OptionSheet` uses: Layout, Sort by, Order, Show). A right swipe starting in the left third (`installFocusSwipe`, `leftEdge`, sheets ignored) goes up one folder and closes at the root. Escape: viewer → sheet → search → close.
- `ProjectFiles.tsx` is now only the drawer: `menu` + a **Files** row (aria "Open the project's files", hidden when `browse=false`). ‹ Back at the library root returns to the drawer. With no `menu` (Terminal's Focus view) the library opens straight away and its close closes both, so `Terminal.tsx` / `Project.tsx` were not touched. `FileGlyph` / `asViewerFile` are re-exported from `ProjectFiles` (defined in `FilesLibrary`), so `Project.tsx`'s imports are unchanged.
- `mobile-web/src/libraryView.ts` (new): `{ layout, sort, desc, foldersFirst, thumbs }` under `storageKey("mobile.filesLibraryView")`, defaults grid / name / asc / folders on top / thumbs on, each field validated separately, storage refusal tolerated; pure `sortEntries` (Intl.Collator numeric+base; missing or 0 `created` last in both directions; kind order dir, pdf, image, text, file; ties by name ascending); `glyphOf` + `Glyph` moved here; `LISTED_CAP = 500`.
- Sections are sorted separately (`sectionsOf(entries, atRoot, view)`) and stay at the end. Search hits keep the desktop's order (not sorted). The viewer's picture steps follow the shown (sorted) order.
- `api.ts`: `items?: number` on `ProjectFileEntry`, **copied byte-for-byte from A1's uncommitted worktree** (A1 reformatted the one-line interface into a block; I took its exact text), so that hunk should merge clean or as identical on both sides. Folder tiles: "n items" / "1 item" / "500+ items" when `items > 500`; nothing at all when `items` is absent.
- CSS (`style.css`, right after the `.project-files` rules): `.files-library*`, `.files-grid`, `.files-tile*`, `.files-tile-cover*`, `.files-more`, `.files-tile-share`; grid section heads share the list's `.files-section` rules. No animated shadow; the library slides in with the drawer's transform/opacity keyframes, off under reduced motion. Removed the unused `.files-trail` rules (the pill trail is gone; the path menu replaced it).
- Tests: `MobileProjectFiles.test.tsx` reworked for drawer → Files → library (22 tests: Files row opens the library and root ‹ comes back to the drawer; ‹ / path-menu jump / left-edge swipe up and close at root; grid/list toggle remembered across a reload; sort orders incl. missing `created` last both ways, folders first, kind, sections after; `items` absent → no count, never "0 items"; item menu Open / Share / Show in folder; all old search, upload, sections, share, remember, PDF-card cases). New `MobileLibraryView.test.ts` (9). `MobileTerminalFocusStatusLine.test.tsx`: the Focus-view case now expects the library directly, closed by a right swipe at the root (a left swipe no longer closes it).

Extension points for A3 (all in `FilesLibrary.tsx` unless noted)
- **Thumbnails + folder colour on tiles** → `LibraryCover({ projectId, entry, place, thumbs }: LibraryCoverProps)`. It is the only place a grid tile's picture is decided; today it renders `<span class="files-tile-cover files-tile-cover-<glyph>"><FileGlyph/></span>`. `place` = folder names of the folder the entry sits in (`placeOf(trail)`, "" at the root; for search hits it is the hit's own trail), so the thumb key is `projectId + place + entry.name + size + modified` and a folder's colour key is `projectId + (place ? place + "/" : "") + entry.name`. `thumbs` is the view menu's switch (already stored; nothing reads it yet). Only `entry` is destructured today, to keep lint clean — destructure the rest when used. List rows use `FileGlyph` directly in `row()`; colour the list icon there if wanted.
- **Item menu entries (☆ Favorite/Unfavorite, Folder colour, Mark up)** → `itemActions(entry, hit?)` returns `ItemAction[]` (`{ key, label, run }`, exported type); push new entries there. The item sheet state is `{ kind: "item", entry, at, hit? }` where `at` is the trail of the folder the entry is listed in (set for hits too) — use it for the favorite's `trail` (`at.slice(1)` as sealed crumbs) and for the colour place. A colour picker sheet can be added as a new `Sheet` variant (`type Sheet` + `sheetOver()`); Escape already closes any sheet.
- **Opening a favorite/recent** → `open(entry, at)`: the one open path (folders walk in, files open in the viewer, PDFs become cards). Pass `[trail[0], ...savedCrumbs]` as `at`, like `openHit` does. A recent should be recorded inside `open()` for files (`entry.kind !== "dir"`).
- **Favorites strip at the root / recents under an empty focused search** → in the returned JSX, `.files-library-body` holds, in order: the search `<input class="files-search">`, Upload here, upload rows, the read-only note, then the listing (`searching ? … : …`). Insert the favorites strip after the note when `atRoot && !searching`; for recents add `onFocus`/`onBlur` state to the search input and render the block in place of the listing while focused and `query` is empty.
- **Thumbnails switch** is `view.thumbs` (`libraryView.ts`); the view menu row already toggles and stores it.

i18n keys added (English + de/es/fr/it, one contiguous block right after `mobile.files.upload.undoFailed`)
`mobile.files.library.{open, back, up, path, view, layout, grid, list, sortBy, sortName, sortModified, sortCreated, sortKind, order, ascending, descending, show, foldersFirst, thumbs}`, `mobile.files.{items, itemsOne, itemsMany}`, `mobile.files.item.{menu, open, share, show}`. Reused: `mobile.files.title` (row + dialog label "Files"), `mobile.files.close` (root ‹ aria), `mobile.files.trail` ("Folders", path sheet title), `mobile.files.atRoot`, `common.close`. A3 adds its own keys (Favorite, Unfavorite, Folder colour, Remove, Recent, moved/deleted note) — put them after my block.

Untested register (`src/lib/untested.ts`): added `mobile.files.library`, `.grid`, `.sort`, `.pathMenu`, `.counts`, **and A3's `.thumbs`, `.favorites`, `.recent`, `.colors`** (described per the plan); reworded `mobile.files.browse`. The library header pill checks all of them plus the older `mobile.files.*` ids, so the audit (`scripts/untested.mjs check`) passes with A3's rows already present — A3 need not touch `untested.ts`, only reword a row if its behaviour differs. The drawer's Files row carries the `mobile.files.browse` pill.

Docs: `docs/filemap_frontend.md` ProjectFiles row reworded, rows added for `FilesLibrary.tsx` and `libraryView.ts` (A3 adds `thumbs.ts`). `todo/group-h-crossplatform.md`: new 🖐️ "Full-screen files library" box under 31bo (after the search box) with the 4 platform ✅/❌ pairs.

Gates (worktree, after the commit's content)
- `scripts/gates.sh`: brand PASS, whitespace PASS, lint-fe PASS (0 warnings on the touched files), build PASS (tsc + bundles), vitest `--changed` PASS; Rust gates skipped (no Rust change).
- Full `npx vitest run`: **838 files, 8494 tests passed**.
- `npm run mobile:bundle`: built. (The post-commit hook printed that the running sidecar serves an older PWA bundle — expected, nothing launched.)

Gotchas
- `FileGlyph`'s tint CSS for list rows is scoped `.option-list button > span.files-icon-*`; the grid has its own `.files-tile-cover .files-icon-*` rules. A colour/thumbnail cover should replace the inner `FileGlyph`, not restyle `.files-icon`.
- The grid `<ul>` is `.files-grid` (not `.option-list`); list mode is `.option-list.files-list`. Tests read names via `.files-tile-open strong, .files-list li > button:first-child strong`.
- The view menu keeps itself open after each pick (multiple changes); the path and item menus close on pick.
- `UntestedRegistry.test.ts` fails on a row with no call site — the header pill is the call site for A3's four rows; if A3 adds its own pills, keep or move those `isUntested("…")` literals so every row still has one.

## A3 — thumbnails, favorites, recents, folder colours (after A2)

Done, one commit on `files-lib-a3`: **`66efe235`** `feat(mobile): library thumbnails, favorites, recent files and folder colours` (on top of A2's `cb8bd545`). Not run live.

What changed
- `mobile-web/src/thumbs.ts` (new): `thumbSource` (pictures ≤ 8 MB except `image/svg*`, PDFs ≤ 12 MB), `thumbKey` (JSON array of project, place, name, size, modified, kind — no separator a name can forge), `ThumbCache` over a `ThumbBackend` (IndexedDB `storageDashKey("mobile-thumbs")`, two stores: `thumbs` records `{thumb: Blob}` / `{failed: true}` and `used` timestamps, so the LRU reads numbers only; cap 600; last use re-written at most once a minute; every call resolves, "unavailable" → no covers), `ThumbQueue` (2 at once, a waiting job can leave the line), and `useThumb(coverRef, projectId, entry, place, enabled)` (shared IntersectionObserver, rootMargin 120 px; a tile that scrolls away before its turn is dropped from the queue and re-queued on return). Pictures: fetched by `viewerFileUrl({files}, …)` (the viewer's sealed-token raw route), `createImageBitmap(blob, {resizeWidth: 240, resizeQuality: "medium"})`, falling back to a plain decode + scaled draw; drawn on white (JPEG has no alpha), max 240×480, `image/jpeg` 0.8. PDFs: one hidden `iframe sandbox="allow-scripts" src="/pdf-frame.html"` with MarkupView's own `markup-frame` class (1 px, opacity 0), created fresh per document and removed after (the frame's `open` accepts only one document), serialized through a promise chain; `ready` → `open` (bytes transferred) → `meta` → `snapshot {n:1, width:240}`; every message through `acceptFrameMessage` (stray bitmaps closed); `failed` or 8 s → recorded failure. A fetch that fails (offline, stale token) is NOT recorded, only skipped for the rest of the page's life.
- `mobile-web/src/filesPlace.ts`: generic `projectLists` (per-project arrays under one `storageKey`, `valid*` per entry, cap, try/catch, listener) backing `readFavorites/isFavorite/toggleFavorite/removeFavorite/onFavorites` (`FilesSaved {kind, name, token, trail}`, cap 50, newest first, oldest dropped), `readRecents/recordRecent/removeRecent/onRecents` (`FilesRecent` = saved + `size`, `modified`; dirs refused; cap 20) and `readFolderColors/setFolderColor/onFolderColors` (`[place, id]` pairs per project, cap 200, ids matching `^[a-z][a-z0-9-]{0,31}$` kept even if unknown — rendered as none via `tabColorCss`). Identity: `savedPlace` = trail names + name. Keys: `mobile.filesFavorites`, `mobile.filesRecents`, `mobile.filesFolderColors`.
- `FilesLibrary.tsx`: `LibraryCover` now uses `useThumb` (img over the glyph, fades in by opacity class, glyph stays when missing/failed) and a folder colour (inline 8-digit-hex tint on cover border/background + `FileGlyph`'s new `color` prop, also used by list rows). Favorites strip (`section.files-saved` "Favorites", horizontal `.files-grid.files-strip` tiles) at the root when not searching; recents (`section.files-saved` "Recent", current layout) replace the listing while the search box is focused and empty (`onMouseDown` preventDefault keeps the box focused so the tap lands). `recordRecent` is called inside `open()` for files. Saved items open via `openSaved`: list the parent folder (last trail token), find the entry by name + dir-ness → fresh token/size/time → `open(entry, [root, ...trail])`; not listed (and the listing not truncated) or `file_not_found` → item dimmed (`files-stale`, per session) + "gone" `OptionSheet` ("{name} was moved or deleted." + Remove). `itemActions(entry, at, hit?, saved?)` order: Open, Share (not for saved items — their token may be old), Favorite/Unfavorite, Folder colour (dirs → new `Sheet` kind `color`, the `ColorSheet` chip grid with No colour + `TAB_COLOR_IDS`, stays open with Done), Show in folder (hits and saved), Mark up. Favorites show no meta line and no thumbnail (they keep no size/time to key one).
- **Mark up**: offered when `markup || showTab` and the kind is a PDF or a picture other than GIF (mirrors `OutboxViewer.markable`). It opens the viewer exactly as a tap does with `startMarking`. `OutboxViewer` already supported that for pictures; for PDFs I added an optional `startMarking` prop to `MarkupView` (reader opens marking regardless of "PDFs open in") and `OutboxViewer` passes it through. `Project.tsx` passes `startMarking` only for pictures, so its cards are unchanged. Stepping to another picture resets it.
- CSS (`style.css`, after the grid rules): `.files-tile-cover` gets `position:relative`; `.files-thumb` (+ `.shown`, reduced-motion off), `.files-saved`, `.files-strip`, `.files-stale`. No shadow animated.

i18n keys (English + de/es/fr/it, right after A2's `mobile.files.item.show`)
`mobile.files.item.{favorite, unfavorite, color}`, `mobile.files.color.{title, note}`, `mobile.files.{favorites, recent, recentNone}`, `mobile.files.saved.{gone, remove}`. Reused: `mobile.markup.open` (Mark up), `tabColor.none` (No colour), `tabColor.*` swatch labels, `mobile.gitSheet.done`, `common.close`. `untested.ts` not touched (A2's four rows read right).

Docs: `docs/filemap_frontend.md` — new `thumbs.ts` row; ProjectFiles/filesPlace and FilesLibrary rows extended by one clause each.

Gates (worktree)
- `scripts/gates.sh`: brand PASS, whitespace PASS, lint-fe PASS (touched files 0 warnings with `--max-warnings 0`), build PASS (tsc + bundles), vitest `--changed` PASS; Rust gates skipped (no Rust change).
- Full `npx vitest run`: **840 files, 8519 tests passed** (A2: 838 / 8494; +25: `MobileFilesSaved.test.ts` 10, `MobileThumbs.test.ts` 9, `MobileProjectFiles.test.tsx` +6 → 28).
- `npm run mobile:bundle`: built (post-commit hook says the running sidecar serves an older PWA — expected, nothing launched).

Gotchas
- After the viewer closes, `FilesLibrary` renders a new `section` — tests must re-query `dialog "Files"` (old element is detached).
- With favorites stored, "Open the folder src" exists twice at the root (strip + listing); tests scope to `getByRole("list", { name: <folder> })`.
- jsdom has no IntersectionObserver/IndexedDB/createImageBitmap, so covers never start in tests unless stubbed; `thumbs.ts`'s observer is a module singleton made on first use.
- A favorite file inside a folder whose listing is truncated (> 500) and not among the first 500 opens with its kept token and size 0 / time 0 (no fresh row to take); recents have their stored size/time.
- Stale (dimmed) marks are per library session; a favorite is only checked when tapped, never polled.
- Hidden-iframe rendering relies on the browser not throttling a 1 px transparent cross-origin frame — the same setup MarkupView already uses, but not verified live for covers.

## Flagged for user

- (A3) The item menu's **Mark up** (opens the viewer marking; PDFs via the new `MarkupView` `startMarking`) has no untested-register row of its own; it is covered only by the library header's pill through the other `mobile.files.*` ids. Add a row (e.g. `mobile.files.markup`) if it should be tracked separately.
- (A3) Favorites are checked only when tapped (one folder listing each), so a moved favorite looks normal until first tapped; pre-checking all 50 on every root visit was judged too many requests. Say if a background check at the root is wanted.

