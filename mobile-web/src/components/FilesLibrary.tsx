import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRightIcon } from "../../../src/components/common/icons/Icon";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { STANDARD_PROJECT_FILES } from "../../../src/lib/viewers/fileUtils";
import { ApiError, listProjectFiles, searchProjectFiles, undoProjectUpload, uploadProjectFile, type FilesSide, type OutboxFile, type ProjectFileEntry, type ProjectFileHit, type ProjectFileListing, type ProjectFileSearch, type ViewerScope } from "../api";
import { filesPlaceId, isFavorite, onFavorites, onFolderColors, onRecents, openFileTab, readFavorites, readFilesPlace, readFolderColors, readRecents, recordRecent, rememberFilesPlace, removeFavorite, removeRecent, savedPlace, setFolderColor, toggleFavorite, type FilesCrumb, type FilesRecent, type FilesSaved } from "../filesPlace";
import { LISTED_CAP, LIBRARY_SORTS, glyphOf, readLibraryView, sortEntries, writeLibraryView, type Glyph, type LibrarySort, type LibraryView } from "../libraryView";
import { shareAs, useOutboxShare } from "../outboxShare";
import { TAB_COLORS, TAB_COLOR_IDS, TAB_COLOR_LABELS, tabColorCss } from "../tabColors";
import { formatBytes } from "../../../src/lib/formatBytes";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { useThumb } from "../thumbs";
import { OptionSheet } from "./OptionSheet";
import { OutboxViewer, type MarkupNewTab, type MarkupTarget } from "./OutboxViewer";
import { usePhonePicks, type PickedFile } from "./phonePicks";
import { useBackLayer } from "../backStack";

/** One folder on the way down: its sealed token (none for the project root)
 * and the name the reader tapped. */
export type Crumb = { token?: string; name: string };

/** A listed file as the viewer takes it, fetched by its token. */
export function asViewerFile(entry: ProjectFileEntry): OutboxFile {
  return { name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, ref: entry.token };
}

/** The folder names below the project root a trail stands in ("" at the
 * root): what the phone keys a place by, since tokens are sealed again on
 * every listing. */
export function placeOf(trail: Crumb[]): string {
  return trail.slice(1).map((crumb) => crumb.name).join("/");
}

/** A listed time as the row prints it, in the app's language and as
 * short as it can be told apart: the clock for today, the day this year, the
 * whole date before that. */
function stampLabel(seconds: number, lang: Language, now = new Date()): string {
  const when = new Date(seconds * 1000);
  if (when.toDateString() === now.toDateString()) return when.toLocaleTimeString(lang, { timeStyle: "short" });
  return when.toLocaleDateString(lang, when.getFullYear() === now.getFullYear()
    ? { day: "numeric", month: "short" }
    : { dateStyle: "medium" });
}

const SHEET = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5";
const GLYPHS: Record<Glyph, ReactNode> = {
  dir: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 15.5-4.5-4.5-9.5 8.5" /></>,
  pdf: <><path d={SHEET} /><path d="M8.5 13.5h7M8.5 17h4.5" /></>,
  text: <><path d={SHEET} /><path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4" /></>,
  file: <path d={SHEET} />,
};

/** A row's tinted kind tile; the project screen's file cards and the grid's
 * covers wear it too. `color` (a folder's, `tabColorCss`) tints it instead. */
export function FileGlyph({ kind, color }: { kind: string; color?: string }) {
  const glyph = glyphOf(kind);
  return <span className={`files-icon files-icon-${glyph}`} style={color ? { background: `${color}40`, color } : undefined} aria-hidden="true">
    <svg viewBox="0 0 24 24">{GLYPHS[glyph]}</svg>
  </span>;
}

/** What a grid tile's cover is drawn from. `place` is the folder the entry
 * sits in (`placeOf`), so a cover can be keyed by project, place, name, size
 * and time; `thumbs` is the view menu's Thumbnails switch; `color` a folder's
 * colour (`tabColorCss`), none for a file or an uncoloured folder; `side` the
 * library's side, `host` for a remote project's tree on its host. */
export interface LibraryCoverProps {
  projectId: string;
  entry: ProjectFileEntry;
  place: string;
  thumbs: boolean;
  color?: string;
  side?: FilesSide;
}

/** A grid tile's cover: the large kind icon, tinted in a folder's colour, and
 * over it a picture or PDF's thumbnail (`thumbs.ts`) once the phone made one —
 * faded in; a missing or failed one leaves the icon. The one place a tile's
 * picture is decided. */
export function LibraryCover({ projectId, entry, place, thumbs, color, side }: LibraryCoverProps) {
  const cover = useRef<HTMLSpanElement>(null);
  const thumb = useThumb(cover, projectId, entry, place, thumbs, side);
  const [loaded, setLoaded] = useState<string | null>(null);
  return <span ref={cover} className={`files-tile-cover files-tile-cover-${glyphOf(entry.kind)}`}
    style={color ? { background: `${color}29`, borderColor: `${color}80` } : undefined}>
    <FileGlyph kind={entry.kind} color={color} />
    {thumb && <img className={loaded === thumb ? "files-thumb shown" : "files-thumb"} src={thumb} alt="" draggable={false}
      onLoad={() => setLoaded(thumb)} />}
  </span>;
}

/** The folder's rows as the desktop tree groups them: the rest first, then
 * the project root's scaffold (README, AGENTS.md, …) and what git ignores,
 * each folded into its own section. A scaffold file git ignores stays a
 * scaffold file, as on the desktop. Each section is sorted on its own, so the
 * folded ones stay at the end whatever the sort. */
function sectionsOf(entries: ProjectFileEntry[], atRoot: boolean, view: LibraryView) {
  const scaffold = atRoot ? entries.filter((entry) => STANDARD_PROJECT_FILES.has(entry.name)) : [];
  const rest = atRoot ? entries.filter((entry) => !STANDARD_PROJECT_FILES.has(entry.name)) : entries;
  return {
    regular: sortEntries(rest.filter((entry) => !entry.ignored), view),
    scaffold: sortEntries(scaffold, view),
    ignored: sortEntries(rest.filter((entry) => entry.ignored), view),
  };
}

type T = ReturnType<typeof useT>;

/** The line under a list row's name: a file's size, then when it was created
 * (where the desktop's filesystem says) and last edited. */
function rowMeta(entry: ProjectFileEntry, t: T, lang: Language): string {
  return [
    entry.kind !== "dir" ? formatBytes(entry.size) : null,
    entry.created ? t("mobile.files.created", { when: stampLabel(entry.created, lang) }) : null,
    entry.modified > 0 ? t("mobile.files.edited", { when: stampLabel(entry.modified, lang) }) : null,
  ].filter(Boolean).join(" · ");
}

/** A folder's item count as the desktop counted it; nothing when it sent none
 * (an older desktop, or its count ran out of budget) — never "0 items". */
function itemsLabel(items: number | undefined, t: T): string {
  if (items === undefined || !Number.isFinite(items) || items < 0) return "";
  if (items > LISTED_CAP) return t("mobile.files.itemsMany", { count: LISTED_CAP });
  return items === 1 ? t("mobile.files.itemsOne") : t("mobile.files.items", { count: items });
}

/** The line under a grid tile's name: a folder's item count, a file's date and size. */
function tileMeta(entry: ProjectFileEntry, t: T, lang: Language): string {
  if (entry.kind === "dir") return itemsLabel(entry.items, t);
  return [entry.modified > 0 ? stampLabel(entry.modified, lang) : null, formatBytes(entry.size)].filter(Boolean).join(" · ");
}

/** The message for a listing (or a search) the sidecar refused. */
function failureKey(reason: unknown, fallback: TranslationKey = "mobile.files.error"): TranslationKey {
  if (reason instanceof ApiError) {
    if (reason.code === "files_off") return "mobile.files.off";
    if (reason.code === "file_not_found") return "mobile.files.gone";
    if (reason.code === "host_offline") return "mobile.files.hostOffline";
  }
  return fallback;
}

/** Why a file did not land in the folder, by the desktop's code. */
const UPLOAD_FAILURES: Record<string, TranslationKey> = {
  uploads_off: "mobile.files.upload.off",
  files_off: "mobile.files.upload.off",
  upload_refused: "mobile.files.upload.refused",
  uploads_full: "mobile.files.upload.full",
  file_too_large: "mobile.sendToDesktop.tooLarge",
  empty_file: "mobile.sendToDesktop.empty",
  project_unavailable: "mobile.projectInbox.unavailable",
  project_not_found: "mobile.projectInbox.notShared",
  file_not_found: "mobile.files.upload.gone",
  files_unavailable: "mobile.files.upload.gone",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
};
/** Why an Undo left the file where it is, by the desktop's code. */
const UNDO_FAILURES: Record<string, TranslationKey> = {
  file_not_found: "mobile.files.upload.undoGone",
  uploads_off: "mobile.files.upload.undoOff",
  files_off: "mobile.files.upload.undoOff",
  timeout: "mobile.files.upload.undoRetry",
  offline: "mobile.files.upload.undoRetry",
};
/** Refusals after which the folder is listed again: its Upload here (the
 * listing's `uploads`) or the folder itself may be gone. */
const RELIST = new Set(["uploads_off", "files_off", "upload_refused", "file_not_found", "files_unavailable"]);

const codeOf = (reason: unknown) => reason instanceof ApiError ? reason.code : "";

/** A pick for **Upload here**: the folder it was picked in (its token, none
 * at the root, and its trail's names for the row), the library's visit to that
 * folder (Undo is offered only while it lasts), and once it landed, the
 * file's own name — the desktop's, which may be `name-2.pdf` — and token. */
interface FolderUpload extends PickedFile {
  folder?: string;
  place: string;
  visit: number;
  landed?: { token: string; name: string };
  undoing?: boolean;
  undone?: boolean;
  /** Why the last Undo kept the file; `undoFinal` when another try would
   * not change that. */
  undoFailure?: string;
  undoFinal?: boolean;
}

/** How long typing rests before the search goes out. */
const SEARCH_DEBOUNCE_MS = 250;
/** The sidecar's bound on a query (`files::MAX_QUERY`, bytes). */
const MAX_QUERY = 80;
/** A right swipe starting in this share of the screen's width, from the left
 * edge, goes up one folder (as a tab's Focus view opens the files from it). */
const UP_SWIPE_ZONE = 1 / 3;

/** One entry of an item's menu (▾ on a tile, ⋯ on a row). */
export interface ItemAction { key: string; label: string; run: () => void }

/** A favorite or a recent file as the library shows it, and which list it is in. */
type Saved = { item: FilesSaved | FilesRecent; from: "favorite" | "recent" };

/** The sheet over the library, if any: the path menu (the title), the view
 * menu (⋯), one item's menu — with the folder the item was listed in — a
 * folder's colours, or a favorite or recent that no longer opens. */
type Sheet = { kind: "path" } | { kind: "view" }
  | { kind: "item"; entry: ProjectFileEntry; at: Crumb[]; hit?: ProjectFileHit; saved?: Saved }
  | { kind: "color"; place: string; name: string }
  | { kind: "gone"; saved: Saved };

/** The sealed crumbs below the root of a trail, as favorites and recents keep them. */
const crumbsOf = (at: Crumb[]): FilesCrumb[] => at.slice(1).flatMap((crumb) => crumb.token ? [{ token: crumb.token, name: crumb.name }] : []);

/** A saved item as a listed entry, for the tile and row it is drawn as; a
 * favorite keeps no size or time. */
function savedEntry(item: FilesSaved | FilesRecent): ProjectFileEntry {
  return { token: item.token, name: item.name, kind: item.kind, size: "size" in item ? item.size : 0, modified: "modified" in item ? item.modified : 0 };
}

/** What the viewer can mark up (`OutboxViewer`): a PDF, or a picture but a GIF. */
const markable = (kind: string) => kind === "application/pdf" || (kind.startsWith("image/") && kind !== "image/gif");

const SORT_LABELS: Record<LibrarySort, TranslationKey> = {
  name: "mobile.files.library.sortName",
  modified: "mobile.files.library.sortModified",
  created: "mobile.files.library.sortCreated",
  kind: "mobile.files.library.sortKind",
};

const CHECK = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>;

/**
 * The project's own tree (`files.rs`, #31bo) as a full-screen library, opened
 * by the drawer's **Files** row (`ProjectFiles`): folders to walk into and
 * files to open — a picture, a PDF or a text — in the outbox's full-screen
 * viewer, with its Save and Share (a PDF then goes on to the browser's
 * viewer). Nothing here changes a file that is there.
 *
 * The head reads ‹ *parent* (at the root ‹ Back, which closes the library),
 * the folder's name — tapping it opens the path menu, every folder from the
 * root down to this one — and ⋯, the view menu: Grid or List, Sort by
 * (`libraryView.ts`, remembered per phone), Folders on top, Thumbnails. A
 * right swipe from the left edge goes up one folder too.
 *
 * In the grid each entry is a tile — a cover (`LibraryCover`: a thumbnail,
 * or the kind icon in a folder's colour), the name on two lines, a folder's
 * item count or a file's date and size — with a ▾ item menu: Open, Share where
 * the phone's share sheet takes the file, Favorite / Unfavorite, Folder colour,
 * Show in folder for a search hit, a favorite or a recent, and Mark up for a
 * PDF or picture where the library offers markup. A list row is the old
 * drawer's row with ↗ Share and a ⋯ for the same menu.
 *
 * Favorites (a strip of tiles at the root), recent files (under the search
 * box while it is focused and empty) and folder colours are this phone's own
 * (`filesPlace.ts`). Each is opened by its folder's listing, so a favorite
 * that was moved or deleted says so, dimmed, and offers Remove.
 *
 * Where the desktop allows it (the listing's `uploads`), **Upload here** adds
 * files from this phone to the folder the library stands in (`uploads.rs`):
 * one after another, each under its own name, never over an existing file.
 * A landed file's row offers Undo while the library stays in that folder; the
 * desktop deletes it only while it is still unchanged.
 *
 * The project root's scaffold files and everything git ignores sit in
 * collapsed sections after the rest, as in the desktop's file tree.
 *
 * The phone never holds a path: each folder and file is a sealed token the
 * sidecar handed out, and the trail is the tokens walked so far. The trail is
 * remembered per project (`filesPlace.ts`), so the library opens again in the
 * folder it was put away in — after a viewed file, a closed library or a
 * reloaded app alike. A remembered folder that no longer lists steps back to
 * the nearest one that does.
 *
 * The search box finds a file or folder anywhere in the project by name
 * (`files/search`; what git ignores is not searched), in the desktop's order.
 * Each hit carries the sealed folders above it, so opening one moves the
 * library there: a folder is walked into, a file opens with the library
 * standing in its folder — and the results are still there when the viewer
 * closes.
 *
 * A remote project's library has two sides (`side`): this computer's folder
 * (its mirror) and the project's tree on its host, read over the desktop's
 * connection to it (`host_files.rs`). The root's switch (`onSide`) picks one;
 * each side keeps its own trail, favorites, recents and colours
 * (`filesPlaceId`). The host's side only reads: no Upload here, no Mark up,
 * and its PDFs become no cards on the project screen. With the desktop not
 * connected to the host it says so.
 */
export function FilesLibrary({ projectId, label, onClose, markup: markupOffer, showTab: showTabOffer, linked, side = "here", onSide }: {
  projectId: string;
  /** The project's name: the root's title. */
  label: string;
  /** ‹ Back at the root, Escape, or a right swipe at the root. */
  onClose: () => void;
  /** An agent tab's library offers **Mark up** on its PDFs and pictures; the
   * project screen's passes none (it has no chat). The library finds a
   * file's newest version itself (`refresh`). */
  markup?: Omit<MarkupTarget, "projectId" | "place" | "folder" | "refresh">;
  /** With no `markup`, Mark up's Submit opens a new agent tab, and the
   * view's Open tab button shows it through this (`MarkupNewTab`). */
  showTab?: MarkupNewTab["show"];
  /** The agent tab a file's card sends its marks to (`MarkupNewTab`). */
  linked?: MarkupNewTab["linked"];
  /** Which tree the library shows: this computer's, or (`host`) the remote
   * project's on its host. */
  side?: FilesSide;
  /** Both sides are there: the root shows the switch, which calls this. */
  onSide?: (side: FilesSide) => void;
}) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const onHost = side === "host";
  /** What the phone keeps for this side: the trail, favorites, recents, colours. */
  const placeId = filesPlaceId(projectId, side);
  // The host's side only reads: nothing there is marked up.
  const markup = onHost ? undefined : markupOffer;
  const showTab = onHost ? undefined : showTabOffer;
  const [trail, setTrail] = useState<Crumb[]>(() => [{ name: label }, ...readFilesPlace(placeId)]);
  /** Still standing on the remembered trail, not yet listed once: a folder
   * that is gone (or a token a re-keyed host no longer opens) steps back. */
  const restored = useRef(trail.length > 1);
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [fileOpen, setFileOpen] = useState<OutboxFile | null>(null);
  // Both fold shut by default, and stay as set while the library is walked.
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProjectFileSearch | null>(null);
  const [searchFailure, setSearchFailure] = useState<TranslationKey | null>(null);
  const [view, setViewState] = useState<LibraryView>(() => readLibraryView());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const searching = query.trim() !== "";
  const [favorites, setFavorites] = useState(() => readFavorites(placeId));
  const [recents, setRecents] = useState(() => readRecents(placeId));
  const [colors, setColors] = useState(() => readFolderColors(placeId));
  useEffect(() => {
    const offs = [
      onFavorites(() => setFavorites(readFavorites(placeId))),
      onRecents(() => setRecents(readRecents(placeId))),
      onFolderColors(() => setColors(readFolderColors(placeId))),
    ];
    return () => offs.forEach((off) => off());
  }, [placeId]);
  const searchBox = useRef<HTMLInputElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  /** Recent files stand in for the listing while the empty search box has focus. */
  const showRecents = searchFocused && !searching;
  /** Favorites and recents found moved or deleted, by place: dimmed. */
  const [stale, setStale] = useState<ReadonlySet<string>>(() => new Set());
  /** Why a favorite or recent could not be looked up, other than its being gone. */
  const [savedFailure, setSavedFailure] = useState<TranslationKey | null>(null);
  /** The file in the viewer was opened by **Mark up**: the viewer starts marking. */
  const [markOnOpen, setMarkOnOpen] = useState(false);
  const scope = useMemo<ViewerScope>(() => (onHost ? { files: projectId, on: "host" } : { files: projectId }), [projectId, onHost]);
  const sharing = useOutboxShare(scope);
  const here = trail[trail.length - 1];
  const atRoot = trail.length === 1;
  const host = useRef<HTMLElement | null>(null);
  /** Bumped to list the folder again (an upload landed or was undone). */
  const [reload, setReload] = useState(0);
  const relist = useCallback(() => setReload((count) => count + 1), []);
  /** The folder the listing shows: listed again, it is not blanked first. */
  const listed = useRef<string | null>(null);
  /** Counts the library's moves between folders: an upload's Undo lasts only
   * as long as the visit it was picked in. */
  const [visit, setVisit] = useState(0);
  useEffect(() => { setVisit((count) => count + 1); }, [here.token]);

  const setView = (patch: Partial<LibraryView>) => {
    const next = { ...view, ...patch };
    writeLibraryView(next);
    setViewState(next);
  };

  const uploads = usePhonePicks<FolderUpload>({
    testId: "project-files-upload-input",
    tooLarge: t("mobile.sendToDesktop.tooLarge"),
    oneByOne: true,
    send: (file, row, settle) => uploadProjectFile(projectId, row.folder, file, row.name).then(
      (entry) => {
        settle({ state: "sent", landed: { token: entry.token, name: entry.name } });
        relist();
      },
      (reason: unknown) => {
        const code = codeOf(reason);
        settle({ state: "failed", failure: t(UPLOAD_FAILURES[code] ?? "mobile.files.upload.failed") });
        if (RELIST.has(code)) relist();
      },
    ),
  });

  const undo = (row: FolderUpload) => {
    const landed = row.landed;
    if (!landed || row.undoing) return;
    uploads.update(row.id, { undoing: true, undoFailure: undefined });
    void undoProjectUpload(projectId, landed.token).then(
      () => {
        uploads.update(row.id, { undoing: false, undone: true });
        relist();
      },
      (reason: unknown) => {
        const code = codeOf(reason);
        const key = UNDO_FAILURES[code] ?? "mobile.files.upload.undoFailed";
        uploads.update(row.id, { undoing: false, undoFailure: t(key), undoFinal: key !== "mobile.files.upload.undoRetry" });
        if (RELIST.has(code)) relist();
      },
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    const folder = here.token ?? "";
    if (listed.current !== folder) {
      setListing(null);
      setFailure(null);
    }
    listed.current = folder;
    void listProjectFiles(projectId, here.token, controller.signal, side).then(
      (next) => {
        if (controller.signal.aborted) return;
        restored.current = false;
        // A re-list after an upload is not blanked first: a refusal it met
        // before must not outlive this answer.
        setFailure(null);
        setListing(next);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        const key = failureKey(reason);
        if (restored.current && here.token && key === "mobile.files.gone") {
          setTrail((current) => current.slice(0, -1));
          return;
        }
        // Nor may the listing it replaced: its `uploads` would keep Upload
        // here on screen beside the refusal (files switched off).
        setListing(null);
        setFailure(key);
      },
    );
    return () => controller.abort();
  }, [projectId, here.token, reload, side]);

  useEffect(() => {
    // The last results stay up while the next search is out, so typing does
    // not blank the list letter by letter.
    const words = query.trim();
    if (!words) {
      setFound(null);
      setSearchFailure(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchProjectFiles(projectId, words, controller.signal, side).then(
        (next) => {
          if (controller.signal.aborted) return;
          setFound(next);
          setSearchFailure(null);
        },
        (reason) => { if (!controller.signal.aborted) setSearchFailure(failureKey(reason, "mobile.files.searchError")); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, query, side]);

  useEffect(() => {
    rememberFilesPlace(placeId, trail.flatMap((crumb) => crumb.token ? [{ token: crumb.token, name: crumb.name }] : []));
  }, [placeId, trail]);

  const sections = useMemo(() => sectionsOf(listing?.entries ?? [], atRoot, view), [listing, atRoot, view]);

  /** The folder's shown pictures, which the viewer steps through in shown order. */
  const pictures = useMemo(
    () => [...sections.regular, ...(scaffoldOpen ? sections.scaffold : []), ...(ignoredOpen ? sections.ignored : [])]
      .filter((entry) => entry.kind.startsWith("image/")).map(asViewerFile),
    [sections, scaffoldOpen, ignoredOpen],
  );

  /** ‹ and the swipe: up one folder, or out of the library at the root. */
  const up = useCallback(() => {
    if (atRoot) onClose();
    else setTrail((current) => current.length > 1 ? current.slice(0, -1) : current);
  }, [atRoot, onClose]);
  // Back: the sheet over the list first, then a search, then up like ‹. The
  // viewer over the library takes Back itself (`OutboxViewer`).
  useBackLayer(() => {
    if (sheet) setSheet(null);
    else if (searching) setQuery("");
    else up();
  });

  useEffect(() => {
    // The viewer opens over the library and a sheet over its list, so Escape
    // closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fileOpen) setFileOpen(null);
      else if (sheet) setSheet(null);
      else if (searching) setQuery("");
      else if (searchFocused) searchBox.current?.blur();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, sheet, searching, searchFocused, onClose]);

  useEffect(() => {
    // Remounted with the library after a file was viewed, hence `fileOpen`.
    // Not through a sheet laid over it.
    const node = host.current;
    if (fileOpen || !node) return;
    return installFocusSwipe(node, {
      onSwipeRight: (start) => { if (start.x <= window.innerWidth * UP_SWIPE_ZONE) up(); },
      onSwipeLeft: () => {},
    }, { ignore: ".sheet-backdrop", leftEdge: true });
  }, [fileOpen, up]);

  /** Mark up's Reload: the open file's folder listed again, for its fresh
   * token, size and time. The viewer keeps showing it — swapping `fileOpen`
   * would remount the viewer (its key) and lose the markup's view. */
  const refresh = useCallback(async (file: OutboxFile): Promise<OutboxFile | null> => {
    const fresh = await listProjectFiles(projectId, here.token, undefined, side);
    const entry = fresh.entries.find((candidate) => candidate.kind !== "dir" && candidate.name === file.name);
    return entry ? asViewerFile(entry) : null;
  }, [projectId, here.token, side]);

  /** Opens an entry of the folder at `at` (the trail as it stands, or as a
   * search hit's sets it). Every open goes through here; a file becomes the
   * newest recent, and with `mark` (**Mark up**) the viewer starts marking. */
  const open = (entry: ProjectFileEntry, at: Crumb[] = trail, mark = false) => {
    if (entry.kind === "dir") {
      setTrail([...at, { token: entry.token, name: entry.name }]);
      return;
    }
    // A PDF too: the browser's own PDF viewer has no Save or Share, so the
    // viewer's head carries them and its Open button hands the file over.
    // It also becomes a card among the project screen's tabs — this
    // computer's only: a card opens by this side's token.
    if (entry.kind === "application/pdf" && !onHost) {
      const { token, name, kind, size, modified } = entry;
      openFileTab(projectId, { token, name, kind, size, modified, folder: at[at.length - 1].token, place: placeOf(at) });
    }
    recordRecent(placeId, { token: entry.token, name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, trail: crumbsOf(at) });
    setTrail(at);
    setMarkOnOpen(mark);
    setFileOpen(asViewerFile(entry));
  };

  /** The search box is put away: a favorite or recent was opened or shown. */
  const leaveSearch = () => {
    setQuery("");
    setSearchFocused(false);
    searchBox.current?.blur();
  };

  /** A favorite or recent file: its folder is listed for the item's fresh
   * token, size and time, then it opens as a listed one would. One its
   * folder no longer lists (or whose folder is gone) is dimmed and says so. */
  const openSaved = (saved: Saved, mark = false) => {
    const { item } = saved;
    const place = savedPlace(item);
    const settle = (isStale: boolean) => setStale((known) => {
      if (known.has(place) === isStale) return known;
      const next = new Set(known);
      if (isStale) next.add(place);
      else next.delete(place);
      return next;
    });
    setSavedFailure(null);
    void listProjectFiles(projectId, item.trail[item.trail.length - 1]?.token, undefined, side).then(
      (listing) => {
        const entry = listing.entries.find((candidate) => candidate.name === item.name && (candidate.kind === "dir") === (item.kind === "dir"));
        // A folder past the listing's cap may hold it unlisted: the kept token still opens it.
        if (!entry && !listing.truncated) {
          settle(true);
          setSheet({ kind: "gone", saved });
          return;
        }
        settle(false);
        leaveSearch();
        open(entry ?? savedEntry(item), [trail[0], ...item.trail], mark);
      },
      (reason: unknown) => {
        const key = failureKey(reason);
        if (key === "mobile.files.gone") {
          settle(true);
          setSheet({ kind: "gone", saved });
        } else {
          setSavedFailure(key);
        }
      },
    );
  };

  /** Show in folder for a favorite or recent: the library stands where it is. */
  const showSaved = ({ item }: Saved) => {
    leaveSearch();
    setTrail([trail[0], ...item.trail]);
  };

  /** A folder's colour as the cover and the list icon wear it. */
  const colorOf = (entry: ProjectFileEntry, at: Crumb[]) =>
    entry.kind === "dir" ? tabColorCss(colors.get(savedPlace({ name: entry.name, trail: at.slice(1) }))) : undefined;

  /** A search hit: the library moves to its folder (Mark up's Reload and the
   * picture steps read that folder), a folder hit ends the search there. */
  const openHit = (hit: ProjectFileHit) => {
    if (hit.kind === "dir") setQuery("");
    open(hit, [trail[0], ...hit.trail]);
  };

  /** Show in folder: the search ends with the library standing where the hit is. */
  const showHit = (hit: ProjectFileHit) => {
    setQuery("");
    setTrail([trail[0], ...hit.trail]);
  };

  /** An item menu's entries, in order, for `entry` listed in the folder at
   * `at` — or found by a search (`hit`), or saved as a favorite or recent. A
   * saved item's token may be old, so its Share waits for it to be opened. */
  const itemActions = (entry: ProjectFileEntry, at: Crumb[], hit?: ProjectFileHit, saved?: Saved): ItemAction[] => {
    const file = entry.kind === "dir" || saved ? null : asViewerFile(entry);
    const actions: ItemAction[] = [{ key: "open", label: t("mobile.files.item.open"), run: () => saved ? openSaved(saved) : hit ? openHit(hit) : open(entry) }];
    if (file && shareAs(file)) actions.push({ key: "share", label: t("mobile.files.item.share"), run: () => void sharing.share(file) });
    const item: FilesSaved = saved?.item ?? { kind: entry.kind, name: entry.name, token: entry.token, trail: crumbsOf(at) };
    const starred = isFavorite(placeId, item);
    actions.push({ key: "favorite", label: t(starred ? "mobile.files.item.unfavorite" : "mobile.files.item.favorite"), run: () => { toggleFavorite(placeId, item); } });
    if (entry.kind === "dir") actions.push({ key: "color", label: t("mobile.files.item.color"), run: () => setSheet({ kind: "color", place: savedPlace(item), name: entry.name }) });
    if (hit) actions.push({ key: "show", label: t("mobile.files.item.show"), run: () => showHit(hit) });
    if (saved) actions.push({ key: "show", label: t("mobile.files.item.show"), run: () => showSaved(saved) });
    if ((markup || showTab) && markable(entry.kind)) {
      actions.push({ key: "markup", label: t("mobile.markup.open"), run: () => saved ? openSaved(saved, true) : open(entry, at, true) });
    }
    return actions;
  };

  if (fileOpen) {
    // The folder trail names the file's layer on the phone; its token cannot.
    const place = placeOf(trail);
    return <OutboxViewer key={fileOpen.ref} scope={scope} file={fileOpen} pictures={pictures} startMarking={markOnOpen}
      onStep={(next) => { setMarkOnOpen(false); setFileOpen(next); }} onClose={() => setFileOpen(null)}
      markup={markup && { ...markup, projectId, place, folder: here.token, refresh }} newTab={showTab && { projectId, place, folder: here.token, refresh, show: showTab, linked }} />;
  }

  const openLabel = (entry: ProjectFileEntry) =>
    entry.kind === "dir" ? t("mobile.files.openFolder", { name: entry.name }) : t("mobile.files.openFile", { name: entry.name });
  const hitPlace = (above: readonly { name: string }[]) =>
    <small className="files-hit-place">{above.length ? above.map((crumb) => crumb.name).join("/") : t("mobile.files.atRoot")}</small>;
  /** The folder an item sits in: the trail, a hit's or a saved item's. */
  const atOf = (hit?: ProjectFileHit, saved?: Saved): Crumb[] =>
    saved ? [trail[0], ...saved.item.trail] : hit ? [trail[0], ...hit.trail] : trail;
  const menuButton = (entry: ProjectFileEntry, className: string, glyph: ReactNode, hit?: ProjectFileHit, saved?: Saved) =>
    <button className={className} aria-haspopup="dialog" aria-label={t("mobile.files.item.menu", { name: entry.name })}
      onClick={() => setSheet({ kind: "item", entry, at: atOf(hit, saved), hit, saved })}>{glyph}</button>;
  const tap = (entry: ProjectFileEntry, hit?: ProjectFileHit, saved?: Saved) => {
    if (saved) openSaved(saved);
    else if (hit) openHit(hit);
    else open(entry);
  };
  /** A favorite or recent found moved or deleted. */
  const isStale = (saved?: Saved) => saved !== undefined && stale.has(savedPlace(saved.item));
  const itemClass = (base: string, folded: boolean, saved?: Saved) =>
    [base, folded && "files-folded", isStale(saved) && "files-stale"].filter(Boolean).join(" ") || undefined;

  /** A list row: its tile, name and times, ↗ Share for a file and ⋯ for the
   * item menu. A search hit, favorite or recent names its folder above the
   * times. */
  function row(entry: ProjectFileEntry, folded = false, hit?: ProjectFileHit, saved?: Saved) {
    const file = entry.kind === "dir" || saved ? null : asViewerFile(entry);
    const ready = sharing.ready === entry.name;
    const above = saved?.item.trail ?? hit?.trail;
    return <li key={saved ? savedPlace(saved.item) : entry.token} className={itemClass("", folded, saved)}>
      <button onClick={() => tap(entry, hit, saved)} aria-label={openLabel(entry)}>
        <FileGlyph kind={entry.kind} color={colorOf(entry, atOf(hit, saved))} />
        <span>
          <strong>{entry.name}</strong>
          {above && hitPlace(above)}
          {saved?.from !== "favorite" && <small>{rowMeta(entry, t, lang)}</small>}
        </span>
        {entry.kind === "dir" && <svg className="files-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>}
      </button>
      {file && shareAs(file) && <button
        className="files-share"
        disabled={sharing.busy === entry.name}
        onClick={() => void sharing.share(file)}
        aria-label={t(ready ? "mobile.outbox.shareReadyFile" : "mobile.outbox.shareFile", { name: entry.name })}
      ><span aria-hidden="true"><ArrowUpRightIcon /></span>{ready && t("mobile.outbox.shareReady")}</button>}
      {menuButton(entry, "files-more", <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg>, hit, saved)}
      {sharing.failed === entry.name && <p className="files-share-error" role="alert">{t("mobile.outbox.shareError")}</p>}
    </li>;
  }

  /** A grid tile: its cover, the name on two lines, a folder's item count or
   * a file's date and size, and ▾ for the item menu. A share the phone held
   * back for a second tap (or that failed) says so under it. */
  function tile(entry: ProjectFileEntry, folded = false, hit?: ProjectFileHit, saved?: Saved) {
    const file = entry.kind === "dir" || saved ? null : asViewerFile(entry);
    const meta = saved?.from === "favorite" ? "" : tileMeta(entry, t, lang);
    const at = atOf(hit, saved);
    const above = saved?.item.trail ?? hit?.trail;
    // A favorite keeps no size or time to key a cover by.
    const thumbs = view.thumbs && saved?.from !== "favorite";
    return <li key={saved ? savedPlace(saved.item) : entry.token} className={itemClass("files-tile", folded, saved)}>
      <button className="files-tile-open" onClick={() => tap(entry, hit, saved)} aria-label={openLabel(entry)}>
        <LibraryCover projectId={projectId} entry={entry} place={placeOf(at)} thumbs={thumbs} color={colorOf(entry, at)} side={side} />
        <strong>{entry.name}</strong>
        {above && hitPlace(above)}
        {meta && <small>{meta}</small>}
      </button>
      {menuButton(entry, "files-tile-menu", <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>, hit, saved)}
      {file && sharing.ready === entry.name && <button className="files-tile-share" onClick={() => void sharing.share(file)}
        aria-label={t("mobile.outbox.shareReadyFile", { name: entry.name })}>{t("mobile.outbox.shareReady")}</button>}
      {sharing.failed === entry.name && <p className="files-share-error" role="alert">{t("mobile.outbox.shareError")}</p>}
    </li>;
  }

  const grid = view.layout === "grid";
  const item = grid ? tile : row;
  const listClass = grid ? "files-grid" : "option-list files-list";

  /** One **Upload here** pick: on its way, refused, landed (with Undo while
   * the library stays in its folder), or undone. */
  function uploadRow(upload: FolderUpload) {
    const close = <button onClick={() => uploads.dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.landed?.name ?? upload.name })}>✕</button>;
    if (upload.state === "failed") return <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span>{close}</div>;
    if (upload.state === "sending" || !upload.landed) return <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{t("mobile.files.upload.sending")}</span></div>;
    const name = upload.landed.name;
    if (upload.undone) return <div key={upload.id} className="inbox-upload" role="status"><strong>{name}</strong><span>{t("mobile.files.upload.undone")}</span>{close}</div>;
    const canUndo = upload.visit === visit && !upload.undoFinal;
    return <div key={upload.id} className={upload.undoFailure ? "inbox-upload error" : "inbox-upload landed"} role="status">
      <strong>{name}</strong>
      <span>{upload.undoFailure ?? t("mobile.files.upload.landed", { folder: upload.place })}</span>
      {canUndo && <button disabled={upload.undoing} onClick={() => undo(upload)} aria-label={t("mobile.files.upload.undoLabel", { name })}>{t("mobile.files.upload.undo")}</button>}
      {close}
    </div>;
  }

  /** A folded section: the desktop tree's divider (across the whole grid),
   * then its entries when open. */
  function section(kind: "scaffold" | "ignored", isOpen: boolean, setOpen: (open: boolean) => void, entries: ProjectFileEntry[]) {
    const scaffold = kind === "scaffold";
    return <>
      <li className="files-section">
        <button aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}
          title={t(scaffold ? (isOpen ? "fileTree.collapseScaffold" : "fileTree.expandScaffold") : (isOpen ? "fileTree.collapseGitignored" : "fileTree.expandGitignored"))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          <span>{t(scaffold ? "fileTree.scaffoldSection" : "fileTree.gitignoredSection", { count: entries.length })}</span>
        </button>
      </li>
      {isOpen && entries.map((entry) => item(entry, !scaffold))}
    </>;
  }

  /** The view menu (⋯): the sheet's own rows, grouped, each choice applied at
   * once and ticked; the sheet stays up for the next one. */
  function viewSheet() {
    const choice = (key: string, labelText: string, on: boolean, pick: () => void) =>
      <li key={key}><button className={on ? "current" : ""} aria-pressed={on} onClick={pick}><span><strong>{labelText}</strong></span>{on && CHECK}</button></li>;
    const group = (heading: TranslationKey, rows: ReactNode[]) =>
      <div className="notifications-group"><h3>{t(heading)}</h3><ul className="option-list">{rows}</ul></div>;
    return <div className="sheet-backdrop" role="presentation" onClick={() => setSheet(null)}>
      <section className="option-sheet files-view-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.files.library.view")} onClick={(event) => event.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <header>
          <button className="sheet-close" onClick={() => setSheet(null)} aria-label={t("common.close")}>✕</button>
          <h2>{t("mobile.files.library.view")}</h2>
          <span className="sheet-close" aria-hidden="true" />
        </header>
        {group("mobile.files.library.layout", [
          choice("grid", t("mobile.files.library.grid"), grid, () => setView({ layout: "grid" })),
          choice("list", t("mobile.files.library.list"), !grid, () => setView({ layout: "list" })),
        ])}
        {group("mobile.files.library.sortBy", LIBRARY_SORTS.map((sort) =>
          choice(sort, t(SORT_LABELS[sort]), view.sort === sort, () => setView({ sort }))))}
        {group("mobile.files.library.order", [
          choice("asc", t("mobile.files.library.ascending"), !view.desc, () => setView({ desc: false })),
          choice("desc", t("mobile.files.library.descending"), view.desc, () => setView({ desc: true })),
        ])}
        {group("mobile.files.library.show", [
          choice("folders", t("mobile.files.library.foldersFirst"), view.foldersFirst, () => setView({ foldersFirst: !view.foldersFirst })),
          choice("thumbs", t("mobile.files.library.thumbs"), view.thumbs, () => setView({ thumbs: !view.thumbs })),
        ])}
      </section>
    </div>;
  }

  /** A folder's colours: the palette's swatches and No colour, applied on the
   * tap and ringed; the sheet stays up, as the tab colour sheet does. */
  function colorSheet(place: string, name: string) {
    const current = tabColorCss(colors.get(place)) ? colors.get(place) : undefined;
    const close = () => setSheet(null);
    return <div className="sheet-backdrop" role="presentation" onClick={close}>
      <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.files.color.title", { name })} onClick={(event) => event.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <header><button className="sheet-close" onClick={close} aria-label={t("common.close")}>✕</button><h2>{t("mobile.files.item.color")}</h2><span className="sheet-close" aria-hidden="true" /></header>
        <p className="sheet-note">{t("mobile.files.color.note", { name })}</p>
        <div className="tab-color-grid" role="group" aria-label={t("mobile.files.item.color")}>
          <button type="button" className={`tab-color-chip none${current ? "" : " is-current"}`} aria-pressed={!current} onClick={() => setFolderColor(placeId, place, null)}>
            <span className="tab-color-chip-dot none" aria-hidden="true" />
            {t("tabColor.none")}
          </button>
          {TAB_COLOR_IDS.map((id) => <button key={id} type="button" className={`tab-color-chip${current === id ? " is-current" : ""}`} aria-pressed={current === id}
            onClick={() => setFolderColor(placeId, place, id)}>
            <span className="tab-color-chip-dot" style={{ background: TAB_COLORS[id] }} aria-hidden="true" />
            {TAB_COLOR_LABELS[id] ? t(TAB_COLOR_LABELS[id]) : id}
          </button>)}
        </div>
        <div className="mobile-schedule-form">
          <div className="mobile-schedule-actions"><button onClick={close}>{t("mobile.gitSheet.done")}</button></div>
        </div>
      </section>
    </div>;
  }

  function sheetOver(shown: Sheet) {
    if (shown.kind === "view") return viewSheet();
    if (shown.kind === "color") return colorSheet(shown.place, shown.name);
    if (shown.kind === "gone") {
      const { saved } = shown;
      const favorite = saved.from === "favorite";
      return <OptionSheet title={saved.item.name} note={{ text: t("mobile.files.saved.gone", { name: saved.item.name }) }} waiting="" busy={false}
        onClose={() => setSheet(null)}
        options={[{ key: "remove", label: t("mobile.files.saved.remove"), current: false }]}
        onPick={() => {
          setSheet(null);
          if (favorite) removeFavorite(placeId, saved.item);
          else removeRecent(placeId, saved.item);
        }} />;
    }
    if (shown.kind === "path") {
      return <OptionSheet title={t("mobile.files.trail")} waiting="" busy={false} onClose={() => setSheet(null)}
        options={trail.map((crumb, index) => ({
          key: String(index),
          label: crumb.name,
          description: index === 0 ? t("mobile.files.atRoot") : undefined,
          current: index === trail.length - 1,
        }))}
        onPick={(key) => {
          const index = Number(key);
          setSheet(null);
          setTrail((current) => current.slice(0, index + 1));
        }} />;
    }
    const actions = itemActions(shown.entry, shown.at, shown.hit, shown.saved);
    return <OptionSheet title={shown.entry.name} waiting="" busy={false} onClose={() => setSheet(null)}
      options={actions.map(({ key, label: text }) => ({ key, label: text, current: false }))}
      onPick={(key) => {
        setSheet(null);
        actions.find((action) => action.key === key)?.run();
      }} />;
  }

  const parent = trail.length > 1 ? trail[trail.length - 2] : null;
  const untested = isUntested("mobile.files.browse") || isUntested("mobile.files.library") || isUntested("mobile.files.grid")
    || isUntested("mobile.files.sort") || isUntested("mobile.files.pathMenu") || isUntested("mobile.files.counts")
    || isUntested("mobile.files.thumbs") || isUntested("mobile.files.favorites") || isUntested("mobile.files.recent")
    || isUntested("mobile.files.colors") || isUntested("mobile.files.share") || isUntested("mobile.files.sections")
    || isUntested("mobile.files.remember") || isUntested("mobile.files.search") || isUntested("mobile.files.upload")
    || ((onSide !== undefined || onHost) && isUntested("mobile.files.host"));

  return <section ref={host} className="files-library" role="dialog" aria-modal="true" aria-label={t("mobile.files.title")}>
    <header className="files-library-head">
      <button className="files-library-back" onClick={up}
        aria-label={parent ? t("mobile.files.library.up", { name: parent.name }) : t("mobile.files.close")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        <span>{parent ? parent.name : t("mobile.files.library.back")}</span>
      </button>
      <h2>
        <button className="files-library-title" aria-haspopup="dialog" onClick={() => setSheet({ kind: "path" })}
          aria-label={t("mobile.files.library.path", { name: here.name })}>{here.name}</button>
        {untested && <small>{t("mobile.outbox.untested")}</small>}
      </h2>
      <button className="files-library-more" aria-haspopup="dialog" onClick={() => setSheet({ kind: "view" })} aria-label={t("mobile.files.library.view")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" /></svg>
      </button>
    </header>
    <div className="files-library-body">
      {atRoot && onSide && <div className="terminal-view-switch files-side-switch" role="group" aria-label={t("mobile.files.side.label")}>
        <button className={onHost ? "" : "selected"} aria-pressed={!onHost} onClick={() => onSide("here")}>{t("mobile.files.side.here")}</button>
        <button className={onHost ? "selected" : ""} aria-pressed={onHost} onClick={() => onSide("host")}>{t("mobile.files.side.host")}</button>
      </div>}
      <input ref={searchBox} className="files-search" type="search" value={query} maxLength={MAX_QUERY} enterKeyHint="search"
        placeholder={t("mobile.files.searchPlaceholder")} aria-label={t("mobile.files.search")}
        onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} />
      {!searching && listing?.uploads && <button className="new-tab-file files-upload" onClick={() => uploads.open({ folder: here.token, place: here.name, visit })}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
        <span><strong>{t("mobile.files.upload.button")}</strong><small>{t("mobile.files.upload.hint")}</small></span>
      </button>}
      {uploads.input}
      {uploads.rows.map(uploadRow)}
      <p className="sheet-note files-note">{t(!searching && listing?.uploads ? "mobile.files.addOnly" : "mobile.files.readOnly")}</p>
      {savedFailure && <p className="sheet-note error" role="alert">{t(savedFailure)}</p>}
      {atRoot && !searching && !showRecents && favorites.length > 0 && <section className="files-saved" aria-label={t("mobile.files.favorites")}>
        <h3>{t("mobile.files.favorites")}</h3>
        <ul className="files-grid files-strip">
          {favorites.map((favorite) => tile(savedEntry(favorite), false, undefined, { item: favorite, from: "favorite" }))}
        </ul>
      </section>}
      {showRecents
        // Pressing a recent must not take the focus from the search box first,
        // or the list would be gone before the tap lands.
        ? <section className="files-saved" aria-label={t("mobile.files.recent")} onMouseDown={(event) => event.preventDefault()}>
          <h3>{t("mobile.files.recent")}</h3>
          {recents.length === 0
            ? <p className="sheet-note">{t("mobile.files.recentNone")}</p>
            : <ul className={listClass}>{recents.map((recent) => item(savedEntry(recent), false, undefined, { item: recent, from: "recent" }))}</ul>}
        </section>
        : searching ? searchFailure
        ? <p className="sheet-note error" role="alert">{t(searchFailure)}</p>
        : !found
          ? <p className="sheet-note">{t("mobile.files.searching")}</p>
          : found.hits.length === 0
            ? <p className="sheet-note">{t("mobile.files.noHits")}</p>
            : <ul className={listClass} aria-label={t("mobile.files.search")}>
              {found.hits.map((hit) => item(hit, false, hit))}
            </ul>
        : failure
          ? <p className="sheet-note error" role="alert">{t(failure)}</p>
          : !listing
            ? <p className="sheet-note">{t("mobile.files.loading")}</p>
            : listing.entries.length === 0
              ? <p className="sheet-note">{t("mobile.files.empty")}</p>
              : <ul className={listClass} aria-label={here.name}>
                {sections.regular.map((entry) => item(entry))}
                {sections.scaffold.length > 0 && section("scaffold", scaffoldOpen, setScaffoldOpen, sections.scaffold)}
                {sections.ignored.length > 0 && section("ignored", ignoredOpen, setIgnoredOpen, sections.ignored)}
              </ul>}
      {showRecents ? null : searching
        ? found?.truncated && <p className="sheet-note">{t("mobile.files.searchTruncated", { count: found.hits.length })}</p>
        : listing?.truncated && <p className="sheet-note">{t("mobile.files.truncated", { count: listing.entries.length })}</p>}
    </div>
    {sheet && sheetOver(sheet)}
  </section>;
}
