import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type ReactNode } from "react";
import { CloseIcon } from "../glyphs";
import { ArrowUpRightIcon } from "../../../src/components/common/icons/Icon";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { STANDARD_PROJECT_FILES } from "../../../src/lib/viewers/fileUtils";
import { ApiError, MAX_UPLOAD_FILE, checkProjectFolderZip, makeProjectFolder, markablePicture, listProjectFiles, lookUpFileRow, lookUpProjectFile, projectFolderZipUrl, searchProjectFiles, undoProjectFolder, undoProjectUpload, uploadProjectFile, type FilesSide, type OutboxFile, type ProjectFileEntry, type ProjectFileHit, type ProjectFileListing, type ProjectFileSearch, type ViewerScope } from "../api";
import { filesPlaceId, isFavorite, onFavorites, onFolderColors, onRecents, openFileTab, readFavorites, readFilesPlace, readFolderColors, readRecents, recordRecent, rememberFilesPlace, removeFavorite, removeRecent, savedPlace, setFolderColor, toggleFavorite, type FilesCrumb, type FilesRecent, type FilesSaved } from "../filesPlace";
import { LISTED_CAP, LIBRARY_SORTS, glyphOf, readLibraryView, sortEntries, writeLibraryView, type Glyph, type LibrarySort, type LibraryView } from "../libraryView";
import { MAX_SHARE_MANY, canShareFiles, shareAs, useOutboxShare, useShareMany } from "../outboxShare";
import { TAB_COLORS, TAB_COLOR_IDS, tabColorCss } from "../../../src/lib/theme/tabColors";
import { formatBytes } from "../../../src/lib/formatBytes";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { holdCovers, useThumb } from "../thumbs";
import { OptionSheet } from "./OptionSheet";
import { OutboxViewer, type MarkupNewTab, type MarkupTarget } from "./OutboxViewer";
import { usePhonePicks, type PickedFile } from "./phonePicks";
import { goBack, useBackLayer } from "../backStack";
import { useTapHolds } from "../newTabDefault";
import { useModalFocus } from "../modalFocus";
import { useMediaQuery } from "../useMediaQuery";

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
  media: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="m10 9 5 3-5 3z" /></>,
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
function sectionsOf(entries: ProjectFileEntry[], atRoot: boolean, view: LibraryView, lang?: string) {
  const scaffold = atRoot ? entries.filter((entry) => STANDARD_PROJECT_FILES.has(entry.name)) : [];
  const rest = atRoot ? entries.filter((entry) => !STANDARD_PROJECT_FILES.has(entry.name)) : entries;
  return {
    regular: sortEntries(rest.filter((entry) => !entry.ignored), view, lang),
    scaffold: sortEntries(scaffold, view, lang),
    ignored: sortEntries(rest.filter((entry) => entry.ignored), view, lang),
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

/** The rest of the sidecar's refusals of a listing or a search, said as
 * what happened rather than "Error" (`FilesError::code`, `files_scope`). */
const REFUSALS: Record<string, TranslationKey> = {
  project_unavailable: "mobile.files.unavailable",
  files_unavailable: "mobile.files.notBrowsable",
  read_failed: "mobile.files.readFailed",
  file_too_large: "mobile.files.tooLarge",
  query_too_long: "mobile.files.queryTooLong",
  timeout: "mobile.files.timeout",
  offline: "mobile.files.offline",
};

/** The message for a listing (or a search) the sidecar refused. */
export function failureKey(reason: unknown, fallback: TranslationKey = "mobile.files.error"): TranslationKey {
  if (reason instanceof ApiError) {
    if (reason.code === "files_off") return "mobile.files.off";
    if (reason.code === "file_not_found") return "mobile.files.gone";
    if (reason.code === "host_offline") return "mobile.files.hostOffline";
    if (reason.code === "project_not_found") return "mobile.favorites.projectGone";
    const said = REFUSALS[reason.code];
    if (said) return said;
  }
  return fallback;
}

/** Why a file did not land in the folder, by the desktop's code. */
const UPLOAD_FAILURES: Record<string, TranslationKey> = {
  uploads_off: "mobile.files.upload.off",
  files_off: "mobile.files.upload.off",
  upload_refused: "mobile.files.upload.refused",
  uploads_full: "mobile.files.upload.full",
  uploads_busy: "mobile.files.upload.busy",
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

/** Why **New folder** made nothing, by the desktop's code. */
const FOLDER_FAILURES: Record<string, TranslationKey> = {
  already_exists: "mobile.files.folder.exists",
  upload_refused: "mobile.files.folder.refused",
  folders_full: "mobile.files.folder.full",
  uploads_off: "mobile.files.upload.off",
  files_off: "mobile.files.upload.off",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
};

/** A folder **New folder** made this visit, for its row and its Undo. */
interface MadeFolder {
  entry: ProjectFileEntry;
  state: "made" | "undoing" | "undone";
  failure?: string;
}

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
 * edge, goes up one folder (as a tab's Focus view opens the files from it) —
 * at most `UP_SWIPE_MAX` px in: a third of an iPad is most of a list. */
const UP_SWIPE_ZONE = 1 / 3;
const UP_SWIPE_MAX = 160;

/** A wide screen held sideways (an iPad in landscape): an open file stands
 * beside the folder (`files-split`) rather than over it. */
const SPLIT_QUERY = "(min-width: 900px) and (orientation: landscape)";

/** The buttons the arrow keys walk, in the order they are drawn: a tile, a
 * list row, a folded section's divider. */
const ITEM_BUTTONS = ".files-tile-open, .files-list > li:not(.files-section) > button:first-of-type, .files-section > button";

/** The item the arrow `key` lands on from `current` among `items`: the
 * nearest one that way on screen — the next row down keeps the column, as a
 * grid reads. Where nothing is laid out (no sizes), the next or previous one
 * in order. */
function itemToward(items: HTMLElement[], current: HTMLElement | null, key: string): HTMLElement | undefined {
  if (!current || !items.includes(current)) return items[0];
  const at = items.indexOf(current);
  const from = current.getBoundingClientRect();
  if (from.width === 0 && from.height === 0) {
    const step = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
    return items[Math.min(items.length - 1, Math.max(0, at + step))];
  }
  const middle = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const here = middle(from);
  let best: { item: HTMLElement; score: number } | undefined;
  for (const item of items) {
    if (item === current) continue;
    const rect = item.getBoundingClientRect();
    const there = middle(rect);
    const sameRow = Math.abs(there.y - here.y) < from.height / 2;
    const ahead = key === "ArrowDown" ? rect.top >= from.bottom - 1
      : key === "ArrowUp" ? rect.bottom <= from.top + 1
      : key === "ArrowRight" ? sameRow && rect.left >= from.right - 1
      : sameRow && rect.right <= from.left + 1;
    if (!ahead) continue;
    // Across rows: the nearest row first, then the nearest column in it.
    const score = key === "ArrowDown" || key === "ArrowUp"
      ? Math.abs(there.y - here.y) * 10_000 + Math.abs(there.x - here.x)
      : Math.abs(there.x - here.x);
    if (!best || score < best.score) best = { item, score };
  }
  return best?.item;
}

/** Where the library's list was scrolled in each folder it showed, by side
 * and folder (`placeOf`): going up a folder, or opening the library again in
 * this app session, lands where the reader left that folder. Kept for the
 * page's life only; tokens are sealed again on every listing, so names. */
const OFFSETS = new Map<string, number>();

/** One entry of an item's menu (▾ on a tile, ⋯ on a row). */
export interface ItemAction { key: string; label: string; run: () => void }

/** A favorite or a recent file as the library shows it, and which list it is in. */
type Saved = { item: FilesSaved | FilesRecent; from: "favorite" | "recent" };

/** A favorite or recent as its folder holds it now (`lookUpProjectFile`, one
 * row rather than the whole folder): its fresh token, size and time, or —
 * from an older desktop, whose folder listing was cut at its cap — the kept
 * row. `null` when it was moved or deleted, or a file stands where a folder
 * was (or the other way round). */
export async function lookUpSaved(projectId: string, item: FilesSaved, side: FilesSide): Promise<ProjectFileEntry | null> {
  try {
    const found = await lookUpProjectFile(projectId, item.trail[item.trail.length - 1]?.token, item.name, side);
    if (found === "unlisted") return savedEntry(item);
    return found && (found.kind === "dir") === (item.kind === "dir") ? found : null;
  } catch (reason) {
    if (failureKey(reason) === "mobile.files.gone") return null;
    throw reason;
  }
}

/** A file was opened from the folder at `crumbs`: it becomes the newest
 * recent, and a PDF a card among the project screen's tabs too — this
 * computer's only, since a card opens by this side's token. */
export function noteFileOpened(projectId: string, side: FilesSide, entry: ProjectFileEntry, crumbs: FilesCrumb[]): void {
  const { token, name, kind, size, modified } = entry;
  if (kind === "application/pdf" && side !== "host") {
    openFileTab(projectId, { token, name, kind, size, modified, folder: crumbs[crumbs.length - 1]?.token, place: crumbs.map((crumb) => crumb.name).join("/") });
  }
  recordRecent(filesPlaceId(projectId, side), { token, name, kind, size, modified, trail: crumbs });
}

/** The sheet over the library, if any: the path menu (the title), the view
 * menu (⋯), one item's menu — with the folder the item was listed in — a
 * folder's colours, or a favorite or recent that no longer opens. */
type Sheet = { kind: "path" } | { kind: "view" } | { kind: "folder" }
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

/** What the viewer can mark up (`OutboxViewer`): a PDF, or a picture every
 * phone can draw (not a GIF, not a HEIC, which an Android phone cannot). */
const markable = (kind: string) => kind === "application/pdf" || markablePicture(kind);

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
 * The search box stands above the list, which scrolls without it, and finds
 * a file or folder anywhere in the project by name (`files/search`; what git
 * ignores is not searched, which finding nothing says), in the desktop's order.
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
export function FilesLibrary({ projectId, label, onClose, markup: markupOffer, showTab: showTabOffer, linked, side = "here", onSide, hostLabel, focusSearch = false }: {
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
  /** The remote side's name on the switch; without one, "Remote computer". */
  hostLabel?: string;
  /** Opened to search: the box takes the focus, so its recents show. */
  focusSearch?: boolean;
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
  /** On a wide screen an open file stands beside the folder (`files-split`):
   * the list stays live, and another tap swaps the file shown. */
  const split = useMediaQuery(SPLIT_QUERY);
  const paned = split && fileOpen !== null;
  /** A file is open over the library, which stays mounted under it — its
   * list keeps its place and the covers already made — but takes no focus,
   * keys or screen reader (`inert`), and starts no new cover meanwhile. The
   * focus goes back to what opened the file when it closes. */
  const covered = fileOpen !== null && !split;
  // Both fold shut by default, and stay as set while the library is walked.
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProjectFileSearch | null>(null);
  /** The search's chips: inside the folder the library stands in, and what
   * git ignores too (this computer's side only). */
  const [searchHere, setSearchHere] = useState(false);
  const [searchIgnored, setSearchIgnored] = useState(false);
  const [searchFailure, setSearchFailure] = useState<TranslationKey | null>(null);
  const [view, setViewState] = useState<LibraryView>(() => readLibraryView());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const press = useTapHolds();
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
  /** Recent files opened by the root's **Recent** link, the box not focused
   * (so the phone's keyboard stays down). */
  const [recentsOpen, setRecentsOpen] = useState(false);
  /** Recent files stand in for the listing while the empty search box has
   * focus, or while the Recent link holds them open. */
  const showRecents = (searchFocused || recentsOpen) && !searching;
  /** Favorites and recents found moved or deleted, by place: dimmed. */
  const [stale, setStale] = useState<ReadonlySet<string>>(() => new Set());
  /** Why a favorite or recent could not be looked up, other than its being gone. */
  const [savedFailure, setSavedFailure] = useState<TranslationKey | null>(null);
  /** The file in the viewer was opened by **Mark up**: the viewer starts marking. */
  const [markOnOpen, setMarkOnOpen] = useState(false);
  const scope = useMemo<ViewerScope>(() => (onHost ? { files: projectId, on: "host" } : { files: projectId }), [projectId, onHost]);
  const sharing = useOutboxShare(scope);
  const shareMany = useShareMany(scope);
  const here = trail[trail.length - 1];
  const atRoot = trail.length === 1;
  /** The folder a search inside it is about (`searchHere`), as its key. */
  const searchDir = searchHere ? here.token ?? "" : null;
  const host = useRef<HTMLElement | null>(null);
  /** Bumped to list the folder again (an upload landed or was undone). */
  const [reload, setReload] = useState(0);
  const relist = useCallback(() => setReload((count) => count + 1), []);
  /** The folder the listing shows: listed again, it is not blanked first. */
  const listed = useRef<string | null>(null);
  /** Counts the library's moves between folders: an upload's Undo lasts only
   * as long as the visit it was picked in. */
  const [visit, setVisit] = useState(0);
  /** **Select files**: a tap ticks a file of this folder instead of opening
   * it, and a bar acts on the ticked ones. Left by Done, Back or Esc, and by
   * going to another folder. */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyMap<string, ProjectFileEntry>>(new Map());
  const [madeFolder, setMadeFolder] = useState<MadeFolder | null>(null);
  /** Files dragged over the list (an iPad's Files app, a Mac's Finder). */
  const [dropping, setDropping] = useState(false);
  /** Why **Download as zip** gave nothing, said under the list's head. */
  const [zipFailure, setZipFailure] = useState<TranslationKey | null>(null);
  /** How many files the last **Download as zip** left out for their names. */
  const [zipSkipped, setZipSkipped] = useState(0);
  useEffect(() => {
    setVisit((count) => count + 1);
    setRecentsOpen(false);
    setSelecting(false);
    setPicked(new Map());
    setMadeFolder(null);
    setZipFailure(null);
  }, [here.token]);
  const leaveSelect = () => {
    setSelecting(false);
    setPicked(new Map());
  };
  const togglePicked = (entry: ProjectFileEntry) => setPicked((current) => {
    const next = new Map(current);
    if (next.has(entry.token)) next.delete(entry.token);
    else next.set(entry.token, entry);
    return next;
  });

  const setView = (patch: Partial<LibraryView>) => {
    const next = { ...view, ...patch };
    writeLibraryView(next);
    setViewState(next);
  };

  const uploads = usePhonePicks<FolderUpload>({
    testId: "project-files-upload-input",
    tooLarge: t("mobile.files.upload.tooLarge"),
    oneByOne: true,
    maxSize: MAX_UPLOAD_FILE,
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

  /** **New folder**: made in the folder the library stands in; its row says
   * so, with an Undo while it is empty and this visit lasts. */
  const makeFolder = async (name: string): Promise<TranslationKey | null> => {
    try {
      const entry = await makeProjectFolder(projectId, here.token, name);
      setMadeFolder({ entry, state: "made" });
      relist();
      return null;
    } catch (reason) {
      const code = codeOf(reason);
      if (RELIST.has(code)) relist();
      return FOLDER_FAILURES[code] ?? "mobile.files.folder.failed";
    }
  };
  const undoFolder = (made: MadeFolder) => {
    if (made.state !== "made") return;
    setMadeFolder({ ...made, state: "undoing", failure: undefined });
    void undoProjectFolder(projectId, made.entry.token).then(
      () => {
        setMadeFolder({ ...made, state: "undone" });
        relist();
      },
      () => setMadeFolder({ ...made, state: "made", failure: t("mobile.files.folder.undoFailed") }),
    );
  };

  /** **Download as zip** of the folder `dir` (none: the root), named `name`:
   * asked first whether it can be zipped, so a refusal is said here rather
   * than saved as a file. */
  const downloadZip = (dir: string | undefined, name: string) => {
    setZipFailure(null);
    setZipSkipped(0);
    void checkProjectFolderZip(projectId, dir).then(
      (answer) => {
        setZipSkipped(answer.skipped ?? 0);
        const link = document.createElement("a");
        link.href = projectFolderZipUrl(projectId, dir);
        link.download = `${name}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      },
      (reason: unknown) => setZipFailure(codeOf(reason) === "folder_too_large" ? "mobile.files.zip.tooLarge" : "mobile.files.zip.failed"),
    );
  };
  /** Files dropped on the list go up as picks do, into this folder. */
  const canDrop = !onHost && !searching && listing?.uploads === true;
  const dropHandlers = canDrop ? {
    onDragOver: (event: ReactDragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropping(true);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (event: ReactDragEvent) => {
      event.preventDefault();
      setDropping(false);
      if (event.dataTransfer.files.length) uploads.add(event.dataTransfer.files, { folder: here.token, place: here.name, visit });
    },
  } : {};

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
    const dir = searchHere ? here.token : undefined;
    // An older desktop answers the whole project whatever `dir` says: the
    // hits outside the folder are left out here, by the names above them.
    const above = searchHere ? trail.slice(1).map((crumb) => crumb.name) : [];
    const inside = (hit: ProjectFileHit) => hit.trail.length >= above.length && above.every((name, at) => hit.trail[at]?.name === name);
    const timer = window.setTimeout(() => {
      void searchProjectFiles(projectId, words, controller.signal, side, { dir, ignored: searchIgnored }).then(
        (next) => {
          if (controller.signal.aborted) return;
          setFound(above.length ? { ...next, hits: next.hits.filter(inside) } : next);
          setSearchFailure(null);
        },
        (reason) => { if (!controller.signal.aborted) setSearchFailure(failureKey(reason, "mobile.files.searchError")); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // `here` and the trail are read through `searchDir`: only a search inside
    // a folder follows the library's moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, query, side, searchDir, searchIgnored]);

  useEffect(() => {
    rememberFilesPlace(placeId, trail.flatMap((crumb) => crumb.token ? [{ token: crumb.token, name: crumb.name }] : []));
  }, [placeId, trail]);

  const sections = useMemo(() => sectionsOf(listing?.entries ?? [], atRoot, view, lang), [listing, atRoot, view, lang]);

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
    else if (selecting) leaveSelect();
    else if (searching) setQuery("");
    else if (recentsOpen) setRecentsOpen(false);
    else up();
  });

  useEffect(() => {
    // The viewer opens over the library and a sheet over its list, so Escape
    // closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // The viewer is closed the way Back closes it: a markup view's Done
      // keeps the note being typed, and a sheet over the view goes first.
      if (fileOpen) goBack();
      else if (sheet) setSheet(null);
      else if (selecting) leaveSelect();
      else if (searching) setQuery("");
      else if (searchFocused) searchBox.current?.blur();
      else if (recentsOpen) setRecentsOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, sheet, selecting, searching, searchFocused, recentsOpen, onClose]);

  useEffect(() => {
    // A keyboard (an iPad's): / or Cmd/Ctrl-F searches, the arrows walk the
    // items (Enter or Space opens one, as a tap), Cmd/Ctrl-↑ or Backspace
    // goes up a folder. Only while the keys are the library's: no sheet, no
    // file over it, the focus nowhere else (a file beside it keeps its own).
    if (sheet || covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const node = host.current;
      const active = document.activeElement;
      if (!node || (active && active !== document.body && !node.contains(active))) return;
      const typing = active instanceof HTMLElement
        && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
      const command = event.metaKey || event.ctrlKey;
      if ((event.key === "/" && !typing && !command) || (command && event.key.toLowerCase() === "f")) {
        event.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
        return;
      }
      if (typing) return;
      if ((command && event.key === "ArrowUp") || (event.key === "Backspace" && !command)) {
        event.preventDefault();
        if (!atRoot) up();
        return;
      }
      if (command || !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const items = Array.from(body.current?.querySelectorAll<HTMLElement>(ITEM_BUTTONS) ?? []);
      if (items.length === 0) return;
      event.preventDefault();
      const next = itemToward(items, active instanceof HTMLElement ? active : null, event.key);
      if (next) {
        next.focus();
        next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, covered, atRoot, up]);

  useEffect(() => {
    // Not while a file is open over the library, nor through a sheet laid
    // over it.
    const node = host.current;
    if ((fileOpen && !split) || !node) return;
    return installFocusSwipe(node, {
      onSwipeRight: (start) => { if (start.x <= Math.min(window.innerWidth * UP_SWIPE_ZONE, UP_SWIPE_MAX)) up(); },
      onSwipeLeft: () => {},
    }, { ignore: ".sheet-backdrop", leftEdge: true });
  }, [fileOpen, split, up]);

  /** This computer's folder is listed again when the reader comes back to it
   * — the app shown again, a file closed — so what an agent wrote meanwhile
   * shows. Rows are replaced in place (tokens are stable), the scroll kept.
   * The host's side is read over SSH, so only Refresh lists it again. */
  const relistHere = useRef(() => {});
  relistHere.current = () => { if (!onHost) relist(); };
  useEffect(() => {
    const node = host.current;
    if (!covered || !node) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && node.contains(active) ? active : null;
    node.setAttribute("inert", "");
    const release = holdCovers();
    return () => {
      node.removeAttribute("inert");
      release();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      relistHere.current();
    };
  }, [covered]);
  useEffect(() => {
    // Beside the folder, the list was never covered: closing the file still
    // lists the folder again, as closing one over it does.
    if (!paned) return;
    return () => relistHere.current();
  }, [paned]);
  useEffect(() => {
    const onShown = () => { if (document.visibilityState === "visible") relistHere.current(); };
    document.addEventListener("visibilitychange", onShown);
    return () => document.removeEventListener("visibilitychange", onShown);
  }, []);

  /** The list's scroll, kept per folder (`OFFSETS`): put back once the
   * folder's listing is on screen, and recorded only from then on, so the
   * blank while a folder lists never counts as where the reader left it. */
  const body = useRef<HTMLDivElement>(null);
  const scrollKey = `${placeId}\n${placeOf(trail)}`;
  const tracking = useRef<string | null>(null);
  const listingShown = !searching && !showRecents && !failure && listing !== null && listed.current === (here.token ?? "");
  useLayoutEffect(() => {
    if (!listingShown) {
      tracking.current = null;
      return;
    }
    if (tracking.current === scrollKey) return;
    const node = body.current;
    if (node) node.scrollTop = OFFSETS.get(scrollKey) ?? 0;
    tracking.current = scrollKey;
  }, [scrollKey, listingShown]);
  const onBodyScroll = () => {
    const node = body.current;
    if (node && tracking.current === scrollKey) OFFSETS.set(scrollKey, node.scrollTop);
  };

  /** Mark up's Reload: the open file looked up again in its folder, for its
   * fresh size and time. The viewer keeps showing it — swapping `fileOpen`
   * would remount the viewer (its key) and lose the markup's view. */
  const refresh = useCallback(async (file: OutboxFile): Promise<OutboxFile | null> => {
    const entry = await lookUpFileRow(projectId, here.token, file.name, side);
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
    noteFileOpened(projectId, side, entry, crumbsOf(at));
    setTrail(at);
    setMarkOnOpen(mark);
    setFileOpen(asViewerFile(entry));
  };

  /** The search box is put away: a favorite or recent was opened or shown. */
  const leaveSearch = () => {
    setQuery("");
    setRecentsOpen(false);
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
    void lookUpSaved(projectId, item, side).then(
      (entry) => {
        if (!entry) {
          settle(true);
          setSheet({ kind: "gone", saved });
          return;
        }
        settle(false);
        leaveSearch();
        open(entry, [trail[0], ...item.trail], mark);
      },
      (reason: unknown) => setSavedFailure(failureKey(reason)),
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
    if (entry.kind === "dir" && !onHost && !saved) {
      actions.push({ key: "zip", label: t("mobile.files.item.zip"), run: () => downloadZip(entry.token, entry.name) });
    }
    // Only a file of the folder on screen can be ticked: a search hit or a
    // saved one may stand elsewhere.
    if (entry.kind !== "dir" && !hit && !saved) {
      actions.push({ key: "select", label: t("mobile.files.item.select"), run: () => { setSelecting(true); setPicked(new Map([[entry.token, entry]])); } });
    }
    return actions;
  };

  // The folder trail names the file's layer on the phone; its token cannot.
  const place = placeOf(trail);
  const viewer = fileOpen && <OutboxViewer key={fileOpen.ref} scope={scope} file={fileOpen} pictures={pictures} startMarking={markOnOpen} paned={paned}
    onStep={(next) => { setMarkOnOpen(false); setFileOpen(next); }} onClose={() => setFileOpen(null)}
    markup={markup && { ...markup, projectId, place, folder: here.token, refresh }} newTab={showTab && { projectId, place, folder: here.token, refresh, show: showTab, linked }} />;

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
  /** Whether a tap on `entry` ticks it (**Select files**) rather than opening it. */
  const ticks = (entry: ProjectFileEntry, hit?: ProjectFileHit, saved?: Saved) => selecting && entry.kind !== "dir" && !hit && !saved;
  const tap = (entry: ProjectFileEntry, hit?: ProjectFileHit, saved?: Saved) => {
    if (ticks(entry, hit, saved)) togglePicked(entry);
    else if (saved) openSaved(saved);
    else if (hit) openHit(hit);
    else open(entry);
  };
  /** A tile's or row's own button: a tap opens, a long-press (or a
   * right-click) opens its item menu, as ▾ / ⋯ do. */
  const pressOf = (entry: ProjectFileEntry, hit?: ProjectFileHit, saved?: Saved) =>
    press(() => tap(entry, hit, saved), () => setSheet({ kind: "item", entry, at: atOf(hit, saved), hit, saved }));
  /** A favorite or recent found moved or deleted. */
  const isStale = (saved?: Saved) => saved !== undefined && stale.has(savedPlace(saved.item));
  /** The file shown beside the folder, marked in the list. */
  const shownBeside = (entry: ProjectFileEntry) => paned && entry.kind !== "dir" && fileOpen?.ref === entry.token;
  const itemClass = (base: string, folded: boolean, saved?: Saved, entry?: ProjectFileEntry) =>
    [base, folded && "files-folded", isStale(saved) && "files-stale", entry && shownBeside(entry) && "files-shown",
      entry && !saved && picked.has(entry.token) && "files-picked"].filter(Boolean).join(" ") || undefined;
  /** In **Select files**, a file's button says whether it is ticked. */
  const pickedState = (entry: ProjectFileEntry, hit?: ProjectFileHit, saved?: Saved) => ticks(entry, hit, saved) ? picked.has(entry.token) : undefined;

  /** A list row: its tile, name and times, ↗ Share for a file and ⋯ for the
   * item menu. A search hit, favorite or recent names its folder above the
   * times. */
  function row(entry: ProjectFileEntry, folded = false, hit?: ProjectFileHit, saved?: Saved) {
    const file = entry.kind === "dir" || saved ? null : asViewerFile(entry);
    const ready = sharing.ready === entry.name;
    const above = saved?.item.trail ?? hit?.trail;
    return <li key={saved ? savedPlace(saved.item) : entry.token} className={itemClass("", folded, saved, entry)}>
      <button {...pressOf(entry, hit, saved)} aria-label={ticks(entry, hit, saved) ? t("mobile.files.select.pick", { name: entry.name }) : openLabel(entry)}
        aria-pressed={pickedState(entry, hit, saved)} aria-current={shownBeside(entry) || undefined}>
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
    return <li key={saved ? savedPlace(saved.item) : entry.token} className={itemClass("files-tile", folded, saved, entry)}>
      <button className="files-tile-open" {...pressOf(entry, hit, saved)} aria-label={ticks(entry, hit, saved) ? t("mobile.files.select.pick", { name: entry.name }) : openLabel(entry)}
        aria-pressed={pickedState(entry, hit, saved)} aria-current={shownBeside(entry) || undefined}>
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

  /** The folder **New folder** made: its name, and Undo while that can work. */
  function folderRow(made: MadeFolder) {
    const name = made.entry.name;
    const close = <button onClick={() => setMadeFolder(null)} aria-label={t("mobile.sendToDesktop.dismiss", { name })}>✕</button>;
    if (made.state === "undone") return <div className="inbox-upload" role="status"><strong>{name}</strong><span>{t("mobile.files.folder.undone")}</span>{close}</div>;
    return <div className={made.failure ? "inbox-upload error" : "inbox-upload landed"} role="status">
      <strong>{name}</strong>
      <span>{made.failure ?? t("mobile.files.folder.made")}</span>
      {!made.failure && <button disabled={made.state === "undoing"} onClick={() => undoFolder(made)}
        aria-label={t("mobile.files.upload.undoLabel", { name })}>{t("mobile.files.upload.undo")}</button>}
      {close}
    </div>;
  }

  /** **Select files**' bar: how many are ticked, Share them together (where
   * the phone shares files and they are small enough to hold), ☆ them, Done. */
  function selectBar() {
    const files = [...picked.values()].map(asViewerFile);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const phase = shareMany.phaseOf(files);
    const shareable = files.length > 0 && canShareFiles() && files.every((file) => shareAs(file) !== null);
    const favorite = () => {
      for (const entry of picked.values()) {
        const item: FilesSaved = { kind: entry.kind, name: entry.name, token: entry.token, trail: crumbsOf(trail) };
        if (!isFavorite(placeId, item)) toggleFavorite(placeId, item);
      }
      leaveSelect();
    };
    return <div className="files-select-bar" role="toolbar" aria-label={t("mobile.files.library.select")}>
      <span role="status">{t("mobile.files.select.count", { count: picked.size })}</span>
      {phase === "failed" && <span className="error" role="alert">{t("mobile.outbox.shareError")}</span>}
      {shareable && (total > MAX_SHARE_MANY
        ? <span className="files-select-note">{t("mobile.files.select.tooBig")}</span>
        : <button disabled={phase === "fetching"} onClick={() => void shareMany.share(files)}>
          {t(phase === "ready" ? "mobile.outbox.shareReady" : "mobile.outbox.share")}
        </button>)}
      <button disabled={picked.size === 0} onClick={favorite}>{t("mobile.files.select.favorite")}</button>
      <button onClick={leaveSelect}>{t("mobile.gitSheet.done")}</button>
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
    return <LibrarySheet className="files-view-sheet" label={t("mobile.files.library.view")} title={t("mobile.files.library.view")} onClose={() => setSheet(null)}>
        <ul className="option-list">
          <li><button onClick={() => { setSheet(null); relist(); }}><span><strong>{t("mobile.files.library.refresh")}</strong></span></button></li>
          {listing && listing.entries.some((entry) => entry.kind !== "dir") && <li><button onClick={() => { setSheet(null); setSelecting(true); }}>
            <span><strong>{t("mobile.files.library.select")}</strong></span></button></li>}
          {canDrop && <li><button onClick={() => setSheet({ kind: "folder" })}><span><strong>{t("mobile.files.library.newFolder")}</strong></span></button></li>}
          {!onHost && <li><button onClick={() => { setSheet(null); downloadZip(here.token, here.token ? here.name : label); }}>
            <span><strong>{t("mobile.files.library.zip")}</strong></span></button></li>}
        </ul>
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
    </LibrarySheet>;
  }

  /** A folder's colours: the palette's swatches and No colour, applied on the
   * tap and ringed; the sheet stays up, as the tab colour sheet does. */
  function colorSheet(place: string, name: string) {
    const current = tabColorCss(colors.get(place)) ? colors.get(place) : undefined;
    const close = () => setSheet(null);
    return <LibrarySheet className="schedule-sheet" label={t("mobile.files.color.title", { name })} title={t("mobile.files.item.color")} onClose={close}>
        <p className="sheet-note">{t("mobile.files.color.note", { name })}</p>
        <div className="tab-color-grid" role="group" aria-label={t("mobile.files.item.color")}>
          <button type="button" className={`tab-color-chip none${current ? "" : " is-current"}`} aria-pressed={!current} onClick={() => setFolderColor(placeId, place, null)}>
            <span className="tab-color-chip-dot none" aria-hidden="true" />
            {t("tabColor.none")}
          </button>
          {TAB_COLOR_IDS.map((id) => <button key={id} type="button" className={`tab-color-chip${current === id ? " is-current" : ""}`} aria-pressed={current === id}
            onClick={() => setFolderColor(placeId, place, id)}>
            <span className="tab-color-chip-dot" style={{ background: TAB_COLORS[id] }} aria-hidden="true" />
            {t(`tabColor.${id}`)}
          </button>)}
        </div>
        <div className="mobile-schedule-form">
          <div className="mobile-schedule-actions"><button onClick={close}>{t("mobile.gitSheet.done")}</button></div>
        </div>
    </LibrarySheet>;
  }

  function sheetOver(shown: Sheet) {
    if (shown.kind === "view") return viewSheet();
    if (shown.kind === "folder") return <NewFolderSheet place={here.name} onClose={() => setSheet(null)} onMake={async (name) => {
      const failure = await makeFolder(name);
      if (!failure) setSheet(null);
      return failure;
    }} />;
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
    || isUntested("mobile.files.remember") || isUntested("mobile.files.keepPlace") || isUntested("mobile.files.pathBar")
    || isUntested("mobile.files.refresh") || isUntested("mobile.files.longPress") || isUntested("mobile.files.searchScope") || isUntested("mobile.files.wide") || isUntested("mobile.files.stream") || isUntested("mobile.files.split") || isUntested("mobile.files.keys") || isUntested("mobile.files.drop") || isUntested("mobile.files.newFolder") || isUntested("mobile.files.zip") || isUntested("mobile.files.select") || isUntested("mobile.files.bigUpload") || isUntested("mobile.files.search") || isUntested("mobile.files.searchButton") || isUntested("mobile.files.upload")
    || ((onSide !== undefined || onHost) && isUntested("mobile.files.host"));

  return <><section ref={host} className={paned ? "files-library files-split" : "files-library"} role="dialog" aria-modal={!paned} aria-label={t("mobile.files.title")}>
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
    <div className="files-library-bar">
      {trail.length > 1 && <PathBar trail={trail} label={t("mobile.files.trail")} onPick={(index) => setTrail((current) => current.slice(0, index + 1))} />}
      {atRoot && onSide && <div className="terminal-view-switch files-side-switch" role="group" aria-label={t("mobile.files.side.label")}>
        <button className={onHost ? "" : "selected"} aria-pressed={!onHost} onClick={() => onSide("here")}>{t("mobile.files.side.here")}</button>
        <button className={onHost ? "selected" : ""} aria-pressed={onHost} onClick={() => onSide("host")}>{hostLabel || t("mobile.files.side.host")}</button>
      </div>}
      <input ref={searchBox} className="files-search" type="search" value={query} maxLength={MAX_QUERY} enterKeyHint="search" autoFocus={focusSearch}
        placeholder={t("mobile.files.searchPlaceholder")} aria-label={t("mobile.files.search")}
        onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} />
      {searching && (!atRoot || !onHost) && <div className="files-search-chips" role="group" aria-label={t("mobile.files.search.scope")}>
        {!atRoot && <button className={searchHere ? "selected" : ""} aria-pressed={searchHere} onClick={() => setSearchHere(!searchHere)}>
          {t("mobile.files.search.here", { name: here.name })}
        </button>}
        {!onHost && <button className={searchIgnored ? "selected" : ""} aria-pressed={searchIgnored} onClick={() => setSearchIgnored(!searchIgnored)}>
          {t("mobile.files.search.ignored")}
        </button>}
      </div>}
      {atRoot && !searching && !showRecents && recents.length > 0 && <button className="files-recent-link" onClick={() => setRecentsOpen(true)}>
        {t("mobile.files.recentShow", { count: recents.length })}
      </button>}
    </div>
    <div ref={body} className={`files-library-body${dropping ? " files-dropping" : ""}${selecting ? " files-selecting" : ""}`} onScroll={onBodyScroll} {...dropHandlers}>
      {dropping && <p className="files-drop-note" role="status">{t("mobile.files.upload.drop", { folder: here.name })}</p>}
      {zipFailure && <p className="sheet-note error" role="alert">{t(zipFailure)}</p>}
      {zipSkipped > 0 && <p className="sheet-note" role="status">{t("mobile.files.zip.skipped", { count: zipSkipped })}</p>}
      {madeFolder && folderRow(madeFolder)}
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
          <h3>{t("mobile.files.recent")}{recentsOpen && !searchFocused
            && <button className="files-recent-hide" onClick={() => setRecentsOpen(false)}>{t("mobile.files.recentHide")}</button>}</h3>
          {recents.length === 0
            ? <p className="sheet-note">{t("mobile.files.recentNone")}</p>
            : <ul className={listClass}>{recents.map((recent) => item(savedEntry(recent), false, undefined, { item: recent, from: "recent" }))}</ul>}
        </section>
        : searching ? searchFailure
        ? <p className="sheet-note error" role="alert">{t(searchFailure)}</p>
        : !found
          ? <p className="sheet-note">{t("mobile.files.searching")}</p>
          : found.hits.length === 0
            ? <p className="sheet-note">{t(onHost || searchIgnored ? "mobile.files.noHits" : "mobile.files.noHitsHere")}</p>
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
        : listing?.truncated && <p className="sheet-note">{t(view.sort === "name" ? "mobile.files.truncated" : "mobile.files.truncatedSorted", { count: listing.entries.length })}</p>}
    </div>
    {selecting && selectBar()}
    {sheet && sheetOver(sheet)}
  </section>{viewer}</>;
}

/** The folders from the project root down to the one shown, as a row under
 * the head that scrolls sideways and stands at its end: a tap on one goes
 * there; the last is where the library stands. The path menu (the title)
 * offers the same. */
function PathBar({ trail, label, onPick }: { trail: Crumb[]; label: string; onPick: (index: number) => void }) {
  const bar = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [trail]);
  return <nav className="files-path" aria-label={label}>
    <ol ref={bar}>
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        return <li key={`${index}/${crumb.name}`}>
          {last
            ? <span aria-current="location">{crumb.name}</span>
            : <button onClick={() => onPick(index)}>{crumb.name}</button>}
        </li>;
      })}
    </ol>
  </nav>;
}

/** **New folder**: a name, and Create. The desktop's refusal (a taken name,
 * a dot name) is said here and the sheet stays up for another try. */
function NewFolderSheet({ place, onClose, onMake }: { place: string; onClose: () => void; onMake: (name: string) => Promise<TranslationKey | null> }) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setFailure(null);
    void onMake(wanted).then((refused) => {
      setBusy(false);
      setFailure(refused);
    });
  };
  return <LibrarySheet className="schedule-sheet files-folder-sheet" label={t("mobile.files.folder.title")} title={t("mobile.files.folder.title")} onClose={onClose}>
    <p className="sheet-note">{t("mobile.files.folder.note", { folder: place })}</p>
    <form className="mobile-schedule-form" onSubmit={submit}>
      <input type="text" value={name} maxLength={120} autoFocus enterKeyHint="done" aria-label={t("mobile.files.folder.name")}
        placeholder={t("mobile.files.folder.name")} onChange={(event) => setName(event.target.value)} />
      {failure && <p className="sheet-note error" role="alert">{t(failure)}</p>}
      <div className="mobile-schedule-actions">
        <button type="submit" disabled={busy || !name.trim()}>{t("mobile.files.folder.create")}</button>
      </div>
    </form>
  </LibrarySheet>;
}

/** The library's own sheets (the view menu, a folder's colours): the shared
 * sheet's frame and its keyboard focus (`useModalFocus`). Back is the
 * library's, which closes the sheet first. */
function LibrarySheet({ className, label, title, onClose, children }: {
  className: string;
  label: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog);
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section ref={dialog} className={`option-sheet ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}><CloseIcon size="1em" /></button>
        <h2>{title}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {children}
    </section>
  </div>;
}
