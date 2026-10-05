/**
 * The TeX editor's beamer/hover-preview switches are the project's, remembered
 * across relaunches (localStorage) and shared by every TeX pane of a project.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTexViewPrefStore, texViewScopeKey } from "../../stores/viewers/texViewPref";
import { storageKey } from "../../lib/brand";

const KEY = storageKey("texViewByProject");

beforeEach(() => {
  localStorage.clear();
  useTexViewPrefStore.setState({ byProject: {} });
});

describe("texViewPref", () => {
  it("keys a project by id and the root scope by 'root'", () => {
    expect(texViewScopeKey("p1")).toBe("p1");
    expect(texViewScopeKey(null)).toBe("root");
    expect(texViewScopeKey(undefined)).toBe("root");
  });

  it("merges a patch into the project's row and persists it", () => {
    useTexViewPrefStore.getState().set("p1", { beamer: true });
    useTexViewPrefStore.getState().set("p1", { hoverPreview: false });
    expect(useTexViewPrefStore.getState().byProject.p1).toEqual({ beamer: true, hoverPreview: false });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      p1: { beamer: true, hoverPreview: false },
    });
  });

  it("ignores junk rows on read, so a hand-edited or stale entry cannot poison the map", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ p1: { beamer: "yes", hoverPreview: false }, p2: 3, p3: null, p4: { beamer: true } }),
    );
    // A write re-reads the persisted map first (two windows share it).
    useTexViewPrefStore.getState().set("p5", { beamer: false });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      p1: { hoverPreview: false },
      p4: { beamer: true },
      p5: { beamer: false },
    });
  });
});
