# Phone files library, GoodNotes-style — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Status: plan only (2026-10-14). No code yet.

## Context

The phone's project files browser (`mobile-web/src/components/ProjectFiles.tsx`,
QA 31bo) is a 420 px left drawer. It shows one list of rows with tinted kind
icons, a breadcrumb of pills, name search, folded scaffold and gitignored
sections, and Upload here. The user wants it to work like GoodNotes' library.

What GoodNotes does, from web research:
- A full-screen Documents library: a grid of covers (folder tiles, first page
  of each notebook) with name and date underneath, and a ▾ item menu on each.
- Grid and list views, switched from a toolbar icon.
- A sort and filter menu: date created, last modified, name, file type.
- Folders nest to any depth, and each can have its own colour.
- Favorites are shortcuts to starred folders, documents and pages.
- The Search tab shows recently opened documents while the search box is empty.
- The main complaint on GoodNotes' feedback forum is that going up means
  pressing ‹ again and again. Users ask for a tree or path view, so we fix that
  here rather than copy it.

The user decided: a **full-screen library**, **thumbnails drawn on the
phone**, and all four feature groups: grid/list with sort, back header with a
path menu, favorites with recents, and folder colours.

## Fixed decisions

1. **One browser, moved rather than copied.** The drawer keeps its menu rows
   (🖼 agent files, ⎇ Git, …) and gains a **Files** row. That row opens the
   full-screen library. The listing, search, upload, sections and viewer code
   moves out of `ProjectFiles.tsx` into the library. The drawer no longer
   lists files itself, so there is no second variant (same props: `markup`,
   `showTab`, `linked`). Both callers stay: `Project.tsx:768` and
   `Terminal.tsx:4528`.
2. **Still read-only, apart from the existing Upload here.** Favorites,
   recents and folder colours are kept only on the phone, in localStorage
   under `storageKey(...)`. Nothing new is written to the desktop, and no file
   is renamed or moved.
3. **Thumbnails are made only on the phone.** The desktop gets no thumbnail
   route and no new image or PDF crate. Images are scaled with
   `createImageBitmap`. A PDF's first page comes from the existing sealed
   pdf.js frame's `snapshot` message, and every message still passes
   `markup/frameProtocol.ts`. No SVG thumbnails: they keep the kind icon. The
   size caps are 8 MB for images and 12 MB for PDFs. Only visible tiles get a
   thumbnail (IntersectionObserver), with at most 2 at a time. The cache lives
   in IndexedDB, keyed by project, place, name, size and modified time, with
   an LRU cap of about 600 entries. A failure is also cached, so the same
   unchanged file is not tried again. The view menu has an on/off switch for
   thumbnails, on by default.
4. **Sorting happens on the phone**, over the listing (500 entries at most;
   the existing truncation note stays). The sort keys are name (natural order
   with `Intl.Collator`'s `numeric` option), modified, created and kind,
   ascending or descending, with **Folders on top** on by default. A missing
   `created` sorts last and is never treated as 0. The view choice is
   remembered per phone, not per folder.
5. **Folder item counts come from the desktop**, the only backend change.
   `files::list` adds an optional `items` to folder entries: the number of
   valid children, capped at `MAX_ENTRIES`, which shows as "500+". It is
   counted only while a scan budget of about 20 000 children per listing
   lasts. When it is missing, nothing is shown, never "0 items". Older hosts
   send no `items` and the tile shows no count. Windows goes through the
   `files_windows.rs` `entries()` path.
6. **Navigation.** The header has ‹ *Parent name* on the left; at the root it
   reads ‹ *Back* and closes the library. The folder title sits in the middle;
   tapping it opens the **path menu**, an `OptionSheet` listing the project
   root, every folder down to this one, and the current folder marked. On the
   right is a ⋯ view menu. A right swipe from the left edge
   (`installFocusSwipe`) goes up one folder, and closes the library at the
   root. The trail stays in `filesPlace.ts` (`readFilesPlace` /
   `rememberFilesPlace`), as today.
7. **Favorites** are per project. Each records `{ kind, name, token, trail }`,
   where `trail` is the sealed crumbs above the item. The cap is 50. Tokens
   from earlier listings still unseal (`files::unseal`), the same way the
   remembered trail does. They show as a horizontal strip at the top of the
   library root. A favorite that no longer opens shows dimmed; tapping it says
   it was moved or deleted and offers Remove.
8. **Recents** are files opened from the library, of any kind, newest first,
   capped at 20 per project. They live in a list separate from `fileTabs`: the
   project screen's cards stay limited to PDFs and marked-up files. Recents
   show while the search box is focused and empty, as in GoodNotes.
9. **Folder colours** are a phone-only map from project and folder place path
   (names, since tokens are sealed again on every listing) to a colour id.
   The palette is `mobile-web/src/tabColors.ts` (`TAB_COLORS`,
   `TAB_COLOR_IDS`, its swatch labels), reused rather than redefined. An
   unknown id shows no colour.
10. **Item menu (▾ on a tile, or ⋯ at the end of a list row).** The entries
    are Open, Share (the existing `useOutboxShare`, only where
    `shareAs(file)`), ☆ Favorite / Unfavorite, Folder colour (folders only),
    Show in folder (search, favorite and recent hits) and Mark up (a PDF or
    picture where `markup`/`showTab` allows it). It uses the shared
    `OptionSheet` / menu style.

## Steps

### A. Backend: folder item counts (small)
- `src-tauri/src/services/mobile_control/files.rs`: add
  `items: Option<u32>` (`skip_serializing_if = None`) to `Entry`. In `list`,
  for each directory call `dir.child_dir(&name)?.entries()`, counting
  `valid_segment` names until `MAX_ENTRIES + 1` or the scan budget runs out.
  The `entry`, `dir_entry` and search hits leave it `None`.
- Tests in `files.rs`: counts match, the cap reads as `MAX_ENTRIES + 1`, an
  exhausted budget leaves `None`, and links are not counted. Build the paths
  with `Path::join`.
- `mobile-web/src/api.ts`: `ProjectFileEntry.items?: number`.
- Afterwards run `npm run backend:stale` and report it. Cross-check Windows
  with the msvc shims (AGENTS.md).

### B. Library screen, view model and navigation
- New `mobile-web/src/components/FilesLibrary.tsx`: a full-screen overlay
  (`.files-library`, safe-area insets). Move the listing, search, upload rows,
  sections, viewer and `refresh` logic here from `ProjectFiles.tsx` unchanged.
  `ProjectFiles.tsx` becomes the drawer with `menu` plus a **Files** row that
  opens the library; `browse=false` hides the row.
- New `mobile-web/src/libraryView.ts`: the stored `{ layout: grid|list,
  sort, desc, foldersFirst, thumbs }` and a pure `sortEntries(entries,
  view)`. Sections are sorted separately, so scaffold and gitignored stay
  folded at the end.
- Header, path menu and swipe as in decision 6. Grid tiles use
  `display:grid; grid-template-columns:repeat(auto-fill,minmax(104px,1fr))`:
  a cover (folder tile in its colour, or a thumbnail, or a large
  `FileGlyph`), the name clamped to 2 lines, a meta line (folder: item count;
  file: date and size, reusing `stampLabel`/`sizeLabel`) and ▾. The list
  layout is today's row plus ⋯. Section headers span the whole grid.
- The view menu (⋯): Grid / List, Sort by (4 keys), Ascending/Descending,
  Folders on top, Thumbnails on/off.
- Styling in `mobile-web/src/style.css`, next to the `.project-files` rules
  (~line 1261). Copy the existing sheet, pill and tile treatments. Animate no
  blurred shadow.

### C. Thumbnails
- New `mobile-web/src/thumbs.ts`: the IndexedDB store (shaped like
  `markup/store.ts`'s `indexedDB.open`), LRU and negative entries, a queue of
  2 at a time, and `useThumb(projectId, entry, place)` built on an
  IntersectionObserver.
- Images: fetch the bytes the same way the viewer does (raw route, sealed
  token), then `createImageBitmap(blob, { resizeWidth: 240 })`, a canvas and
  a JPEG or WebP blob.
- PDFs: one hidden shared frame (`pdf-frame.html`, mounted the way
  `MarkupView` mounts its frame), fed `open` and then `snapshot { n: 1,
  width: 240 }`. Each document opens fresh. Time out after about 8 s and
  record that as a failure.
- Tiles fade in their thumbnail. Missing or failed thumbnails keep the kind
  icon.

### D. Favorites, recents, folder colours, item menu
- `mobile-web/src/filesPlace.ts`: add three stores next to the trail store,
  following the same idiom (array storage, `valid*` checks, caps,
  storage-refusal tolerance): `favorites`, `recent` and `folderColors`, each
  with read, write and toggle helpers and an `on…` listener like
  `onFileTabs`.
- Library: the favorites strip at the root, recents under a focused empty
  search, the item menu (decision 10), and a colour sheet built from
  `TAB_COLOR_IDS` swatches. Opening a favorite or recent sets the trail from
  its stored crumbs, as `openHit` does today.

### E. Wiring, text, register
- i18n: every new display string through `useT()`. English keys go in
  `src/lib/i18n.ts`, with translations in `i18nDicts/{de,es,fr,it}.ts` as the
  other `mobile.files.*` keys do. No app name spelled out.
- `src/lib/untested.ts`: new rows `mobile.files.library`, `.grid`, `.sort`,
  `.pathMenu`, `.thumbs`, `.favorites`, `.recent`, `.colors`, `.counts`.
  Reword `mobile.files.browse` (the drawer row now opens the library). The
  header pill checks the new ids too.
- `docs/filemap_frontend.md`: one-line updates to the ProjectFiles row, and
  new rows for `FilesLibrary.tsx`, `libraryView.ts` and `thumbs.ts`.
  `docs/filemap_backend.md`: note `items` on the files.rs row.
- `todo/` (mobile group, under 31bo): a 🖐️ QA box with the four platform
  ✅/❌ pairs.
- `npm run mobile:bundle`, since the PWA is baked into the binary.

## Organisation (for when implementation is asked for)

Mixed risk, 3 agent steps:
- **A1** = A + the `api.ts` type. Backend, small.
- **A2** = B + E. Library shell; it owns the hot shared files `i18n.ts`,
  `untested.ts` and the filemaps.
- **A3** = C + D. It depends on A2's component, and it lists its i18n and
  untested rows in the handoff so A2's owner (or the merge step) applies them.

The order is A1 ∥ A2, then A3. Only A1 touches the sidecar, so it gets the
security-style finder/verifier review: `files.rs` is the sealed-path
boundary. A2 and A3 get the final review.

## Verification

- Tests:
  - Extend `src/__tests__/mobile/MobileProjectFiles.test.tsx`: the Files row
    opens the library; grid and list toggle; the sort orders match (missing
    `created` last, folders first); ‹ and the path menu go up and jump
    straight to an ancestor; at the root the library closes; favorites and
    recents round-trip and a stale favorite shows Remove; a folder colour
    shows; `items` missing means no count text.
  - New unit tests for `libraryView.sortEntries`, the `filesPlace` stores
    (caps, invalid storage, refused storage) and the `thumbs` cache keying
    and LRU (fake IndexedDB as in the markup store tests).
  - `MobileMarkupTabs.test.tsx` still passes, since the cards still come from
    `fileTabs`.
- Gates: `scripts/gates.sh` (build, tests, cargo test and clippy for the
  backend step, lint, brand-check), `npm run backend:stale`,
  `npm run mobile:bundle`.
- Click-through for the user on a phone. The app is not run here.
  1. Settings → Mobile → Project files on. On the phone, open a project, then
     ☰, then Files: the full-screen library opens at the remembered folder.
  2. Toggle grid and list, then change the sort; reload the app and the
     choice is kept.
  3. Walk 3 folders deep. ‹ goes up one. Tapping the title shows the path
     menu, and picking the root jumps there. A right swipe goes up one.
  4. A folder of PDFs and photos gets real covers as you scroll. Turn
     Thumbnails off: the kind icons are back.
  5. ▾ on a folder: Favorite, then the colour green. At the root the favorite
     strip shows it, green. Rename that folder on the desktop: the favorite
     dims and offers Remove.
  6. Open two files, go back, focus the empty search box: Recents lists both.
  7. Folder tiles show "n items". With an older desktop build the counts are
     simply absent.
