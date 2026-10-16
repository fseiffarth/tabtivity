/**
 * The phone files library's view (`libraryView.ts`): the stored layout and
 * sort, read back field by field with defaults for anything missing, broken
 * or refused, and the one ordering the library applies to a listing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectFileEntry } from "../../../mobile-web/src/api";
import { DEFAULT_LIBRARY_VIEW, readLibraryView, sortEntries, writeLibraryView, type LibraryView } from "../../../mobile-web/src/libraryView";
import { storageKey } from "../../lib/brand";

const KEY = storageKey("mobile.filesLibraryView");

const entry = (name: string, kind: string, modified: number, created?: number): ProjectFileEntry =>
  ({ token: `tok-${name}`, name, kind, size: 1, modified, ...(created === undefined ? {} : { created }) });

const ENTRIES = [
  entry("file10.txt", "text/plain", 300, 30),
  entry("Zeta", "dir", 100),
  entry("file2.txt", "text/plain", 200),
  entry("photo.png", "image/png", 500, 10),
  entry("alpha", "dir", 400, 5),
  entry("paper.pdf", "application/pdf", 100, 0),
];
const names = (view: Partial<LibraryView>) => sortEntries(ENTRIES, { ...DEFAULT_LIBRARY_VIEW, ...view }).map((item) => item.name);

describe("libraryView — sortEntries", () => {
  it("sorts names naturally and case-blind, folders on top", () => {
    expect(names({})).toEqual(["alpha", "Zeta", "file2.txt", "file10.txt", "paper.pdf", "photo.png"]);
    expect(names({ desc: true })).toEqual(["Zeta", "alpha", "photo.png", "paper.pdf", "file10.txt", "file2.txt"]);
    expect(names({ foldersFirst: false })).toEqual(["alpha", "file2.txt", "file10.txt", "paper.pdf", "photo.png", "Zeta"]);
  });

  it("sorts by last edited, ties by name", () => {
    expect(names({ sort: "modified", foldersFirst: false })).toEqual(["paper.pdf", "Zeta", "file2.txt", "file10.txt", "alpha", "photo.png"]);
    expect(names({ sort: "modified", foldersFirst: false, desc: true })).toEqual(["photo.png", "alpha", "file10.txt", "file2.txt", "paper.pdf", "Zeta"]);
  });

  it("puts a missing created time last in both directions, never as 0", () => {
    // paper.pdf's 0 is no created time either.
    expect(names({ sort: "created", foldersFirst: false })).toEqual(["alpha", "photo.png", "file10.txt", "file2.txt", "paper.pdf", "Zeta"]);
    expect(names({ sort: "created", foldersFirst: false, desc: true })).toEqual(["file10.txt", "photo.png", "alpha", "file2.txt", "paper.pdf", "Zeta"]);
    expect(names({ sort: "created", desc: true })).toEqual(["alpha", "Zeta", "file10.txt", "photo.png", "file2.txt", "paper.pdf"]);
  });

  it("groups by kind, then by name", () => {
    expect(names({ sort: "kind", foldersFirst: false })).toEqual(["alpha", "Zeta", "paper.pdf", "photo.png", "file2.txt", "file10.txt"]);
    expect(names({ sort: "kind", foldersFirst: false, desc: true })).toEqual(["file2.txt", "file10.txt", "photo.png", "paper.pdf", "alpha", "Zeta"]);
  });

  it("leaves the listing it was given alone", () => {
    const before = ENTRIES.map((item) => item.name);
    names({ desc: true });
    expect(ENTRIES.map((item) => item.name)).toEqual(before);
  });
});

describe("libraryView — the stored view", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads the defaults when nothing is stored: grid, by name, folders on top, thumbnails on", () => {
    expect(readLibraryView()).toEqual({ layout: "grid", sort: "name", desc: false, foldersFirst: true, thumbs: true });
  });

  it("round-trips a choice", () => {
    const view: LibraryView = { layout: "list", sort: "created", desc: true, foldersFirst: false, thumbs: false };
    writeLibraryView(view);
    expect(readLibraryView()).toEqual(view);
  });

  it("takes the default for each field that is missing or not one it knows", () => {
    localStorage.setItem(KEY, JSON.stringify({ layout: "tiles", sort: "size", desc: "yes", foldersFirst: false }));
    expect(readLibraryView()).toEqual({ ...DEFAULT_LIBRARY_VIEW, foldersFirst: false });
    localStorage.setItem(KEY, "{not json");
    expect(readLibraryView()).toEqual(DEFAULT_LIBRARY_VIEW);
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    expect(readLibraryView()).toEqual(DEFAULT_LIBRARY_VIEW);
  });

  it("rides out a storage that refuses", () => {
    const refusing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    expect(readLibraryView(refusing)).toEqual(DEFAULT_LIBRARY_VIEW);
    expect(() => writeLibraryView({ ...DEFAULT_LIBRARY_VIEW, layout: "list" }, refusing)).not.toThrow();
  });
});
