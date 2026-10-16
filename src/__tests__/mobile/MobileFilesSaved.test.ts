/**
 * The files library's phone-only stores (`filesPlace.ts`): favorites, recent
 * files and folder colours, per project — capped, checked entry by entry on
 * the way in, and riding out a storage that holds garbage or refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAVORITES_CAP,
  FOLDER_COLORS_CAP,
  RECENTS_CAP,
  isFavorite,
  onFavorites,
  onFolderColors,
  onRecents,
  readFavorites,
  readFolderColors,
  readRecents,
  recordRecent,
  removeFavorite,
  removeRecent,
  savedPlace,
  setFolderColor,
  toggleFavorite,
  type FilesRecent,
  type FilesSaved,
} from "../../../mobile-web/src/filesPlace";
import { storageKey } from "../../lib/brand";

const SRC = { token: "tok-src", name: "src" };
const paper: FilesSaved = { kind: "application/pdf", name: "paper.pdf", token: "tok-paper", trail: [SRC] };
const recent = (name: string, extra: Partial<FilesRecent> = {}): FilesRecent =>
  ({ kind: "text/plain", name, token: `tok-${name}`, trail: [SRC], size: 3, modified: 1_770_000_000, ...extra });

const refusing = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
  removeItem: () => { throw new Error("SecurityError"); },
};

describe("files library — favorites", () => {
  beforeEach(() => localStorage.clear());

  it("stars and unstars an item, known by its folders' names and its own, never its token", () => {
    expect(toggleFavorite("p1", paper)).toBe(true);
    expect(readFavorites("p1")).toEqual([paper]);
    // The next listing seals the same file afresh: still the same favorite.
    const resealed = { ...paper, token: "tok-paper-2", trail: [{ token: "tok-src-2", name: "src" }] };
    expect(isFavorite("p1", resealed)).toBe(true);
    expect(isFavorite("p1", { ...paper, trail: [] })).toBe(false);
    expect(readFavorites("p2")).toEqual([]);
    expect(toggleFavorite("p1", resealed)).toBe(false);
    expect(readFavorites("p1")).toEqual([]);
    expect(localStorage.getItem(storageKey("mobile.filesFavorites"))).toBeNull();
  });

  it("puts the newest first and drops the oldest past the cap", () => {
    for (let at = 0; at < FAVORITES_CAP + 3; at++) toggleFavorite("p1", { ...paper, name: `f${at}.pdf`, token: `t${at}` });
    const kept = readFavorites("p1");
    expect(kept).toHaveLength(FAVORITES_CAP);
    expect(kept[0].name).toBe(`f${FAVORITES_CAP + 2}.pdf`);
    expect(kept.some((item) => item.name === "f0.pdf")).toBe(false);
    removeFavorite("p1", { name: `f${FAVORITES_CAP + 2}.pdf`, trail: [{ name: "src" }] });
    expect(readFavorites("p1")).toHaveLength(FAVORITES_CAP - 1);
  });

  it("drops what is not a favorite from storage, keeping the rest", () => {
    localStorage.setItem(storageKey("mobile.filesFavorites"), JSON.stringify({
      p1: [paper, { kind: "dir", name: "", token: "x", trail: [] }, { name: "no-kind", token: "x", trail: [] },
        { ...paper, name: "bad-trail", trail: [{ token: "", name: "src" }] }, "nope"],
      p2: "not a list",
    }));
    expect(readFavorites("p1")).toEqual([paper]);
    expect(readFavorites("p2")).toEqual([]);
    localStorage.setItem(storageKey("mobile.filesFavorites"), "{not json");
    expect(readFavorites("p1")).toEqual([]);
    // A write over garbage starts afresh.
    toggleFavorite("p1", paper);
    expect(readFavorites("p1")).toEqual([paper]);
  });

  it("rides out a storage that refuses, and still tells listeners", () => {
    const listener = vi.fn();
    const off = onFavorites(listener);
    expect(readFavorites("p1", refusing)).toEqual([]);
    expect(() => toggleFavorite("p1", paper, refusing)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    toggleFavorite("p1", paper);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("files library — recent files", () => {
  beforeEach(() => localStorage.clear());

  it("keeps opened files newest first, once each, folders never", () => {
    recordRecent("p1", recent("a.txt"));
    recordRecent("p1", recent("b.txt"));
    recordRecent("p1", recent("a.txt", { token: "tok-a-2", size: 9 }));
    recordRecent("p1", { ...recent("docs"), kind: "dir" });
    expect(readRecents("p1").map((item) => [item.name, item.token, item.size])).toEqual([["a.txt", "tok-a-2", 9], ["b.txt", "tok-b.txt", 3]]);
    removeRecent("p1", { name: "b.txt", trail: [{ name: "src" }] });
    expect(readRecents("p1").map((item) => item.name)).toEqual(["a.txt"]);
  });

  it("caps the list and checks what it reads back", () => {
    for (let at = 0; at < RECENTS_CAP + 5; at++) recordRecent("p1", recent(`r${at}.txt`));
    const kept = readRecents("p1");
    expect(kept).toHaveLength(RECENTS_CAP);
    expect(kept[0].name).toBe(`r${RECENTS_CAP + 4}.txt`);
    localStorage.setItem(storageKey("mobile.filesRecents"), JSON.stringify({
      p1: [recent("ok.txt"), { ...recent("no-size.txt"), size: "3" }, { ...recent("folder"), kind: "dir" }, { ...recent("nan.txt"), modified: null }],
    }));
    expect(readRecents("p1").map((item) => item.name)).toEqual(["ok.txt"]);
  });

  it("rides out a storage that refuses", () => {
    const listener = vi.fn();
    const off = onRecents(listener);
    expect(readRecents("p1", refusing)).toEqual([]);
    expect(() => recordRecent("p1", recent("a.txt"), refusing)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("files library — folder colours", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("colours a folder by its place, clears it, and keeps an id this bundle does not know", () => {
    setFolderColor("p1", "src", "green");
    setFolderColor("p1", "src/deep", "teal");
    setFolderColor("p2", "src", "red");
    expect(readFolderColors("p1")).toEqual(new Map([["src", "green"], ["src/deep", "teal"]]));
    setFolderColor("p1", "src", "blue");
    expect(readFolderColors("p1").get("src")).toBe("blue");
    setFolderColor("p1", "src", null);
    expect(readFolderColors("p1").has("src")).toBe(false);
    // A newer desktop's palette id is kept; the library draws it as no colour.
    setFolderColor("p1", "src", "magenta");
    expect(readFolderColors("p1").get("src")).toBe("magenta");
    expect(savedPlace({ name: "deep", trail: [{ name: "src" }] })).toBe("src/deep");
    expect(savedPlace({ name: "src", trail: [] })).toBe("src");
  });

  it("caps the colours, dropping the longest-standing, and drops malformed pairs", () => {
    for (let at = 0; at < FOLDER_COLORS_CAP + 2; at++) setFolderColor("p1", `d${at}`, "green");
    const kept = readFolderColors("p1");
    expect(kept.size).toBe(FOLDER_COLORS_CAP);
    expect(kept.has("d0")).toBe(false);
    expect(kept.has(`d${FOLDER_COLORS_CAP + 1}`)).toBe(true);
    localStorage.setItem(storageKey("mobile.filesFolderColors"), JSON.stringify({
      p1: [["src", "green"], ["", "red"], ["x", "<b>"], ["y"], "z"],
    }));
    expect(readFolderColors("p1")).toEqual(new Map([["src", "green"]]));
  });

  it("rides out a storage that refuses", () => {
    const listener = vi.fn();
    const off = onFolderColors(listener);
    expect(readFolderColors("p1", refusing).size).toBe(0);
    expect(() => setFolderColor("p1", "src", "green", refusing)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
