import { storageKey } from "../../src/lib/brand";

/**
 * The folder the files library (`FilesLibrary`) was last standing in, per
 * project, so putting the drawer away — or the whole app — and opening it again
 * lands where the reader left off rather than at the project root.
 *
 * What is kept is the drawer's own trail: the sealed tokens the sidecar handed
 * out and the names they were tapped by. No path ever reaches storage. A token
 * that no longer opens (folder gone, host re-keyed) is the drawer's to step
 * back from; this module only holds the trail.
 */
const KEY = storageKey("mobile.filesPlace");

/** Projects remembered at most; the longest-unvisited one goes first. */
const PROJECT_CAP = 50;
/** Deeper than this is not a trail the drawer walked. */
const DEPTH_CAP = 64;

/** One folder below the project root, as the drawer's trail holds it. */
export type FilesCrumb = { token: string; name: string };

type FilesPlaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validCrumb(value: unknown): value is FilesCrumb {
  if (!value || typeof value !== "object") return false;
  const { token, name } = value as Partial<FilesCrumb>;
  return typeof token === "string" && token.length > 0 && token.length <= 4096
    && typeof name === "string" && name.length > 0 && name.length <= 1024;
}

/** Every remembered trail, oldest visit first, checked entry by entry; a
 * bad one is dropped. A list, not an object: an object would order a
 * number-like project id first and the cap would drop the wrong one. */
function load(storage: FilesPlaceStorage): [string, FilesCrumb[]][] {
  const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown): [string, FilesCrumb[]][] => {
    if (!Array.isArray(item) || item.length !== 2) return [];
    const [projectId, trail] = item as unknown[];
    if (typeof projectId !== "string" || !projectId) return [];
    if (!Array.isArray(trail) || trail.length === 0 || trail.length > DEPTH_CAP || !trail.every(validCrumb)) return [];
    return [[projectId, trail.map(({ token, name }) => ({ token, name }))]];
  });
}

/** The folders below the root the drawer last stood in for `projectId`;
 * empty for the root itself or nothing remembered. */
export function readFilesPlace(projectId: string, storage?: FilesPlaceStorage): FilesCrumb[] {
  try {
    return load(storage ?? localStorage).find(([id]) => id === projectId)?.[1] ?? [];
  } catch {
    return [];
  }
}

/** Remember `trail` (the folders below the root) for `projectId`; an empty
 * trail forgets the project, the root being where the drawer opens anyway. */
export function rememberFilesPlace(projectId: string, trail: FilesCrumb[], storage?: FilesPlaceStorage): void {
  try {
    const store = storage ?? localStorage;
    let saved: [string, FilesCrumb[]][];
    try { saved = load(store); } catch { saved = []; }
    // Re-added last, so the list runs in visit order and the cap drops the oldest.
    saved = saved.filter(([id]) => id !== projectId);
    if (trail.length > 0) saved.push([projectId, trail.slice(0, DEPTH_CAP).map(({ token, name }) => ({ token, name }))]);
    saved = saved.slice(-PROJECT_CAP);
    if (saved.length) store.setItem(KEY, JSON.stringify(saved));
    else store.removeItem(KEY);
  } catch {
    // A private browser may refuse storage; the drawer still walks, it only
    // opens at the root next time.
  }
}

/**
 * The PDFs the reader opened from the drawer, and every file it marked up
 * wherever it was opened from (the drawer, the 🖼 gallery, an agent tab's
 * chat), per project, newest first: the project screen lists each as a card
 * among its tabs (`Project.tsx`), so a paper read this morning or a markup
 * under way is one tap away again without walking the folders. They are the
 * phone's own — the desktop opens nothing — and a card's ✕ only forgets it
 * here; a markup's marks stay in the phone's layer store.
 *
 * Each seal carries a fresh nonce, so the same file comes back under a new
 * token on every listing: a project file is known by its folder and name
 * (`place`), and `folder` is the token its folder was listed by, for a fresh
 * row later. A file the agent sent (`from: "outbox"`) is known by its leaf
 * name, which is also its `token`, the key the outbox is read by.
 */
const TABS_KEY = storageKey("mobile.fileTabs");
/** Cards per project; the oldest-opened falls off. */
const TABS_CAP = 12;

export type FileTab = {
  token: string;
  name: string;
  kind: string;
  size: number;
  modified: number;
  /** The token of the folder the file was listed in; none for the root. */
  folder?: string;
  /** The folders below the root, `a/b`; empty for the root and the outbox. */
  place: string;
  /** `outbox`: a file the agent sent (`.tabtivity/outbox/`), read through the
   * project's outbox by its leaf name; absent: a project file. */
  from?: "outbox";
  /** The name the reader knows the file by, where that is not `name` (an
   * outbox leaf's original name, `sentName`). */
  label?: string;
  /** The agent tab the file's markup rounds went to, which the next Submit
   * from the card goes to as well; absent before one was sent. */
  tab?: string;
};

/** What tells two cards' files apart: where they are read from, their folder
 * and their name — never a token, which a new listing seals afresh. */
export type FileTabFile = Pick<FileTab, "from" | "place" | "name">;

function validTab(value: unknown): value is FileTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<FileTab>;
  return validCrumb({ token: tab.token, name: tab.name })
    && typeof tab.kind === "string" && tab.kind.length <= 256
    && typeof tab.size === "number" && typeof tab.modified === "number"
    && (tab.folder === undefined || (typeof tab.folder === "string" && tab.folder.length > 0 && tab.folder.length <= 4096))
    && typeof tab.place === "string" && tab.place.length <= 4096
    && (tab.from === undefined || tab.from === "outbox")
    && (tab.label === undefined || (typeof tab.label === "string" && tab.label.length > 0 && tab.label.length <= 1024))
    && (tab.tab === undefined || (typeof tab.tab === "string" && tab.tab.length > 0 && tab.tab.length <= 256));
}

const sameFile = (a: FileTabFile, b: FileTabFile) => a.from === b.from && a.place === b.place && a.name === b.name;

function loadTabs(storage: FilesPlaceStorage): Record<string, FileTab[]> {
  const parsed: unknown = JSON.parse(storage.getItem(TABS_KEY) ?? "{}");
  const out: Record<string, FileTab[]> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [projectId, tabs] of Object.entries(parsed)) {
    if (!Array.isArray(tabs)) continue;
    const kept = tabs.filter(validTab).slice(0, TABS_CAP)
      .map(({ token, name, kind, size, modified, folder, place, from, label, tab }) => ({ token, name, kind, size, modified, folder, place, from, label, tab }));
    if (kept.length) out[projectId] = kept;
  }
  return out;
}

const tabListeners = new Set<() => void>();

/** Called whenever a project's file tabs change, on this page. */
export function onFileTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => { tabListeners.delete(listener); };
}

function writeTabs(projectId: string, change: (tabs: FileTab[]) => FileTab[], storage?: FilesPlaceStorage): void {
  try {
    const store = storage ?? localStorage;
    let saved: Record<string, FileTab[]>;
    try { saved = loadTabs(store); } catch { saved = {}; }
    const next = change(saved[projectId] ?? []).slice(0, TABS_CAP);
    if (next.length) saved[projectId] = next;
    else delete saved[projectId];
    if (Object.keys(saved).length) store.setItem(TABS_KEY, JSON.stringify(saved));
    else store.removeItem(TABS_KEY);
  } catch {
    // See rememberFilesPlace: without storage there are no file tabs.
  }
  tabListeners.forEach((listener) => listener());
}

/** `projectId`'s file tabs, newest first. */
export function readFileTabs(projectId: string, storage?: FilesPlaceStorage): FileTab[] {
  try {
    return loadTabs(storage ?? localStorage)[projectId] ?? [];
  } catch {
    return [];
  }
}

/** Put `tab` first among `projectId`'s file tabs, in place of an older card
 * for the same file — whose markup's agent tab it keeps. */
export function openFileTab(projectId: string, tab: FileTab, storage?: FilesPlaceStorage): void {
  writeTabs(projectId, (tabs) => {
    const known = tabs.find((other) => sameFile(other, tab));
    return [{ ...tab, tab: tab.tab ?? known?.tab }, ...tabs.filter((other) => !sameFile(other, tab))];
  }, storage);
}

/** `projectId`'s card for `file`, if it has one. */
export function findFileTab(projectId: string, file: FileTabFile, storage?: FilesPlaceStorage): FileTab | undefined {
  return readFileTabs(projectId, storage).find((tab) => sameFile(tab, file));
}

/** A file being marked up gets its card: added first when it has none, else
 * brought up to date where it stands — the row, and `tab` once a round went
 * to one (a card keeps its tab otherwise). Nothing is written when nothing
 * changed, since the markup view calls this as each mark is saved. */
export function keepMarkupTab(projectId: string, tab: FileTab, storage?: FilesPlaceStorage): void {
  const known = readFileTabs(projectId, storage).find((other) => sameFile(other, tab));
  const next: FileTab = { ...known, ...tab, tab: tab.tab ?? known?.tab };
  if (!validTab(next)) return;
  const fields: (keyof FileTab)[] = ["token", "kind", "size", "modified", "folder", "label", "tab"];
  if (known && fields.every((field) => known[field] === next[field])) return;
  writeTabs(projectId, (tabs) => known
    ? tabs.map((other) => sameFile(other, next) ? next : other)
    : [next, ...tabs], storage);
}

/** Replace a card's row with a fresher listing of the same file. */
export function refreshFileTab(projectId: string, tab: FileTab, storage?: FilesPlaceStorage): void {
  writeTabs(projectId, (tabs) => tabs.map((other) => sameFile(other, tab) ? tab : other), storage);
}

/** Forget one card. */
export function closeFileTab(projectId: string, tab: FileTab, storage?: FilesPlaceStorage): void {
  writeTabs(projectId, (tabs) => tabs.filter((other) => !sameFile(other, tab)), storage);
}

/**
 * What the reader keeps in the files library (`FilesLibrary`) beyond the
 * folder it stands in, per project and only on this phone (nothing reaches
 * the desktop): **favorites**, the files and folders starred from an item's
 * menu and shown as a strip at the library's root; **recents**, the files
 * opened from the library, newest first, shown while the search box is
 * focused and empty; and **folder colours**, a palette id (`tabColors.ts`)
 * per folder.
 *
 * Each seal carries a fresh nonce, so an item is known by the folder names
 * above it and its own name, never by a token. The tokens kept — the item's
 * and its folders' (`trail`, the crumbs below the root) — are only for
 * opening it again; one that no longer opens means the item was moved or
 * deleted, which the library says.
 */
export type FilesSaved = { kind: string; name: string; token: string; trail: FilesCrumb[] };
/** A recent file also keeps its size and time, so its cover comes from the
 * thumbnail cache. */
export type FilesRecent = FilesSaved & { size: number; modified: number };
/** What tells two saved items apart: the folders' names and its own. */
export type FilesSavedFile = { name: string; trail: readonly { name: string }[] };

const FAVORITES_KEY = storageKey("mobile.filesFavorites");
const RECENTS_KEY = storageKey("mobile.filesRecents");
const COLORS_KEY = storageKey("mobile.filesFolderColors");
/** Favorites per project; past it the oldest-starred falls off. */
export const FAVORITES_CAP = 50;
/** Recent files per project; the oldest-opened falls off. */
export const RECENTS_CAP = 20;
/** Coloured folders per project; the longest-uncoloured falls off. */
export const FOLDER_COLORS_CAP = 200;

/** A folder's place: its names below the root, `a/b`, as `placeOf` makes it. */
export function savedPlace(item: FilesSavedFile): string {
  return [...item.trail.map((crumb) => crumb.name), item.name].join("/");
}

const sameSaved = (a: FilesSavedFile, b: FilesSavedFile) =>
  a.name === b.name && a.trail.length === b.trail.length && a.trail.every((crumb, index) => crumb.name === b.trail[index].name);

function validSaved(value: unknown): value is FilesSaved {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FilesSaved>;
  return validCrumb({ token: item.token, name: item.name })
    && typeof item.kind === "string" && item.kind.length > 0 && item.kind.length <= 256
    && Array.isArray(item.trail) && item.trail.length <= DEPTH_CAP && item.trail.every(validCrumb);
}

function validRecent(value: unknown): value is FilesRecent {
  if (!validSaved(value)) return false;
  const { size, modified, kind } = value as Partial<FilesRecent>;
  return kind !== "dir" && typeof size === "number" && Number.isFinite(size) && size >= 0
    && typeof modified === "number" && Number.isFinite(modified);
}

const pickSaved = ({ kind, name, token, trail }: FilesSaved): FilesSaved =>
  ({ kind, name, token, trail: trail.map(({ token: crumbToken, name: crumbName }) => ({ token: crumbToken, name: crumbName })) });
const pickRecent = (item: FilesRecent): FilesRecent => ({ ...pickSaved(item), size: item.size, modified: item.modified });

/** One per-project list kept under `key`, entry by entry checked on the way
 * in and out, `cap` long at most, with a listener for this page — the file
 * tabs' idiom above. */
function projectLists<T>(key: string, cap: number, valid: (value: unknown) => value is T, pick: (value: T) => T) {
  const listeners = new Set<() => void>();
  const load = (storage: FilesPlaceStorage): Record<string, T[]> => {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    const out: Record<string, T[]> = {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [projectId, items] of Object.entries(parsed)) {
      if (!projectId || !Array.isArray(items)) continue;
      const kept = items.filter(valid).slice(0, cap).map(pick);
      if (kept.length) out[projectId] = kept;
    }
    return out;
  };
  return {
    read(projectId: string, storage?: FilesPlaceStorage): T[] {
      try {
        return load(storage ?? localStorage)[projectId] ?? [];
      } catch {
        return [];
      }
    },
    write(projectId: string, change: (items: T[]) => T[], storage?: FilesPlaceStorage): void {
      try {
        const store = storage ?? localStorage;
        let saved: Record<string, T[]>;
        try { saved = load(store); } catch { saved = {}; }
        const next = change(saved[projectId] ?? []).filter(valid).slice(0, cap).map(pick);
        if (next.length) saved[projectId] = next;
        else delete saved[projectId];
        if (Object.keys(saved).length) store.setItem(key, JSON.stringify(saved));
        else store.removeItem(key);
      } catch {
        // See rememberFilesPlace: without storage nothing is kept.
      }
      listeners.forEach((listener) => listener());
    },
    listen(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const favorites = projectLists(FAVORITES_KEY, FAVORITES_CAP, validSaved, pickSaved);
const recents = projectLists(RECENTS_KEY, RECENTS_CAP, validRecent, pickRecent);

/** `projectId`'s favorites, the latest starred first. */
export function readFavorites(projectId: string, storage?: FilesPlaceStorage): FilesSaved[] {
  return favorites.read(projectId, storage);
}

/** Whether `item` is among `projectId`'s favorites. */
export function isFavorite(projectId: string, item: FilesSavedFile, storage?: FilesPlaceStorage): boolean {
  return readFavorites(projectId, storage).some((other) => sameSaved(other, item));
}

/** Star `item`, or unstar it when it is a favorite already; answers whether
 * it is one now. A new favorite goes first; past the cap the oldest goes. */
export function toggleFavorite(projectId: string, item: FilesSaved, storage?: FilesPlaceStorage): boolean {
  const was = isFavorite(projectId, item, storage);
  favorites.write(projectId, (items) => was
    ? items.filter((other) => !sameSaved(other, item))
    : [item, ...items], storage);
  return !was;
}

/** Forget one favorite (one that was moved or deleted, say). */
export function removeFavorite(projectId: string, item: FilesSavedFile, storage?: FilesPlaceStorage): void {
  favorites.write(projectId, (items) => items.filter((other) => !sameSaved(other, item)), storage);
}

/** Called whenever a project's favorites change, on this page. */
export function onFavorites(listener: () => void): () => void {
  return favorites.listen(listener);
}

/** `projectId`'s recent files, the last opened first. */
export function readRecents(projectId: string, storage?: FilesPlaceStorage): FilesRecent[] {
  return recents.read(projectId, storage);
}

/** A file was opened from the library: it goes first among the recents, in
 * place of its older entry. Folders are not recents. */
export function recordRecent(projectId: string, item: FilesRecent, storage?: FilesPlaceStorage): void {
  if (item.kind === "dir") return;
  recents.write(projectId, (items) => [item, ...items.filter((other) => !sameSaved(other, item))], storage);
}

/** Forget one recent file. */
export function removeRecent(projectId: string, item: FilesSavedFile, storage?: FilesPlaceStorage): void {
  recents.write(projectId, (items) => items.filter((other) => !sameSaved(other, item)), storage);
}

/** Called whenever a project's recent files change, on this page. */
export function onRecents(listener: () => void): () => void {
  return recents.listen(listener);
}

/** One folder's colour: its place (`a/b`) and a palette id. Kept as pairs, not
 * an object, so a number-like folder name cannot reorder them past the cap. */
type FolderColor = [place: string, color: string];

function validFolderColor(value: unknown): value is FolderColor {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [place, color] = value as unknown[];
  return typeof place === "string" && place.length > 0 && place.length <= 4096
    && typeof color === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(color);
}

const folderColors = projectLists(COLORS_KEY, FOLDER_COLORS_CAP, validFolderColor, ([place, color]): FolderColor => [place, color]);

/** `projectId`'s folder colours by place. An id this bundle's palette does not
 * know is kept, and drawn as no colour (`tabColorCss`). */
export function readFolderColors(projectId: string, storage?: FilesPlaceStorage): Map<string, string> {
  return new Map(folderColors.read(projectId, storage));
}

/** Colour the folder at `place`, or clear its colour with `null`. Newest
 * last, so the cap drops the longest-standing one. */
export function setFolderColor(projectId: string, place: string, color: string | null, storage?: FilesPlaceStorage): void {
  folderColors.write(projectId, (items) => {
    const rest = items.filter(([other]) => other !== place);
    return color ? [...rest, [place, color] as FolderColor].slice(-FOLDER_COLORS_CAP) : rest;
  }, storage);
}

/** Called whenever a project's folder colours change, on this page. */
export function onFolderColors(listener: () => void): () => void {
  return folderColors.listen(listener);
}
