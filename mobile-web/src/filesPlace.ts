import { storageKey } from "../../src/lib/brand";

/**
 * The folder the files drawer (`ProjectFiles`) was last standing in, per
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
