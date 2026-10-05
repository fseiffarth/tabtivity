import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLastPlace, readLastPlace, rememberLastPlace, restoreLastPlace } from "../../../mobile-web/src/lastPlace";
import { BRAND, storageKey } from "../../lib/brand";

/** The storage key predates sections and is kept so a phone does not lose its place on update. */
const KEY = storageKey("mobile.lastTab");

describe(`${BRAND.display} Mobile last-place persistence`, () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("stores only the section and the opaque route needed to restore it", () => {
    rememberLastPlace({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" });

    expect(readLastPlace()).toEqual({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" });
    expect(localStorage.getItem(KEY)).toBe(
      JSON.stringify({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" }),
    );
  });

  it("remembers a section with no project behind it", () => {
    rememberLastPlace({ section: "todo" });
    expect(readLastPlace()).toEqual({ section: "todo" });
  });

  it("reads a pre-sections terminal route as a place under Projects", () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: "project-opaque", tabId: "tab-opaque" }));
    expect(readLastPlace()).toEqual({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" });
  });

  it("ignores malformed saved places and unknown sections", () => {
    localStorage.setItem(KEY, "{broken");
    expect(readLastPlace()).toBeNull();

    localStorage.setItem(KEY, JSON.stringify({ section: "settings" }));
    expect(readLastPlace()).toBeNull();
  });

  it("drops an incomplete route rather than the section carrying it", () => {
    localStorage.setItem(KEY, JSON.stringify({ section: "projects", tabId: "tab-opaque" }));
    expect(readLastPlace()).toEqual({ section: "projects" });
  });

  it("clears the place on sign-out", () => {
    rememberLastPlace({ section: "todo" });
    forgetLastPlace();
    expect(readLastPlace()).toBeNull();
  });

  it("restores a section without asking the host anything", async () => {
    rememberLastPlace({ section: "todo" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(restoreLastPlace()).resolves.toEqual({ section: "todo" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-fetches the current tab instead of restoring its details from storage", async () => {
    rememberLastPlace({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" });
    const tab = { id: "tab-opaque", label: "Fresh host label", kind: "shell" as const, available: true, viewer_busy: false };
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tab }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(restoreLastPlace()).resolves.toEqual({ section: "projects", projectId: "project-opaque", tab });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/tabs/tab-opaque");
  });

  it("falls back to the project when the host says the tab is gone", async () => {
    rememberLastPlace({ section: "projects", projectId: "project-opaque", tabId: "tab-opaque" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "tab_not_found" }),
    }));

    await expect(restoreLastPlace()).resolves.toEqual({ section: "projects", projectId: "project-opaque" });
  });
});
