import { storageKey } from "../../src/lib/brand";
import type { ProjectFileEntry } from "./api";

/**
 * How the phone's files library (`FilesLibrary`) lays out a folder: grid or
 * list, the sort, its direction, folders on top, and whether tiles may draw
 * thumbnails. One choice per phone, not per folder or project, kept in
 * localStorage; a missing, broken or refused store reads as the defaults.
 *
 * `sortEntries` is the one ordering the library applies, on the phone, over
 * the listing the desktop sent (500 entries at most).
 */
const KEY = storageKey("mobile.filesLibraryView");

export type LibraryLayout = "grid" | "list";
export type LibrarySort = "name" | "modified" | "created" | "kind";
export const LIBRARY_SORTS: readonly LibrarySort[] = ["name", "modified", "created", "kind"];

export interface LibraryView {
  layout: LibraryLayout;
  sort: LibrarySort;
  /** Descending: Z→A, newest first, kinds in reverse. */
  desc: boolean;
  /** Folders before files, in either direction. */
  foldersFirst: boolean;
  /** Tiles may draw a thumbnail in place of the kind icon. */
  thumbs: boolean;
}

export const DEFAULT_LIBRARY_VIEW: LibraryView = { layout: "grid", sort: "name", desc: false, foldersFirst: true, thumbs: true };

/** The listing's cap (`files::MAX_ENTRIES`): a folder counted past it says "500+". */
export const LISTED_CAP = 500;

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

/** The stored view, field by field: an unknown or missing value takes its default. */
export function readLibraryView(storage?: ViewStorage): LibraryView {
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_LIBRARY_VIEW };
    const value = parsed as Partial<Record<keyof LibraryView, unknown>>;
    const flag = (key: "desc" | "foldersFirst" | "thumbs") =>
      typeof value[key] === "boolean" ? value[key] as boolean : DEFAULT_LIBRARY_VIEW[key];
    return {
      layout: value.layout === "grid" || value.layout === "list" ? value.layout : DEFAULT_LIBRARY_VIEW.layout,
      sort: LIBRARY_SORTS.includes(value.sort as LibrarySort) ? value.sort as LibrarySort : DEFAULT_LIBRARY_VIEW.sort,
      desc: flag("desc"),
      foldersFirst: flag("foldersFirst"),
      thumbs: flag("thumbs"),
    };
  } catch {
    return { ...DEFAULT_LIBRARY_VIEW };
  }
}

export function writeLibraryView(view: LibraryView, storage?: ViewStorage): void {
  try {
    const { layout, sort, desc, foldersFirst, thumbs } = view;
    (storage ?? localStorage).setItem(KEY, JSON.stringify({ layout, sort, desc, foldersFirst, thumbs }));
  } catch {
    // A private browser may refuse storage; the choice then lasts this visit.
  }
}

/** What a tile draws: a folder, a picture, a PDF, a text, or a file. */
export type Glyph = "dir" | "image" | "pdf" | "text" | "file";

export function glyphOf(kind: string): Glyph {
  if (kind === "dir") return "dir";
  if (kind.startsWith("image/")) return "image";
  if (kind === "application/pdf") return "pdf";
  return kind.startsWith("text/") ? "text" : "file";
}

/** The order Sort by kind groups in, ascending. */
const GLYPH_ORDER: Record<Glyph, number> = { dir: 0, pdf: 1, image: 2, text: 3, file: 4 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A created time the desktop's filesystem knows; none (or 0) is not one. */
const createdOf = (entry: ProjectFileEntry) => entry.created !== undefined && entry.created > 0 ? entry.created : null;

/**
 * `entries` in the view's order, as a new array. Name is natural order
 * (`file2` before `file10`, any case); ties fall back to the name, ascending.
 * A file with no created time sorts after every dated one in both directions
 * — never as 0, which would put it first when ascending. Folders on top holds
 * in both directions too.
 */
export function sortEntries<T extends ProjectFileEntry>(entries: readonly T[], view: Pick<LibraryView, "sort" | "desc" | "foldersFirst">): T[] {
  const sign = view.desc ? -1 : 1;
  const byName = (a: T, b: T) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...entries].sort((a, b) => {
    if (view.foldersFirst) {
      const dirs = Number(b.kind === "dir") - Number(a.kind === "dir");
      if (dirs) return dirs;
    }
    switch (view.sort) {
      case "name":
        return sign * byName(a, b);
      case "modified":
        return sign * (a.modified - b.modified) || byName(a, b);
      case "created": {
        const [ca, cb] = [createdOf(a), createdOf(b)];
        if (ca === null || cb === null) return ca === cb ? byName(a, b) : ca === null ? 1 : -1;
        return sign * (ca - cb) || byName(a, b);
      }
      case "kind":
        return sign * (GLYPH_ORDER[glyphOf(a.kind)] - GLYPH_ORDER[glyphOf(b.kind)]) || byName(a, b);
    }
  });
}
