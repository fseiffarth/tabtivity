/**
 * The two appearance overrides (`stores/settings.applyAccent`/`applyCorners`)
 * and the "system" pseudo-theme (`resolveTheme`).
 *
 * The rules worth pinning: an accent override recolors the DERIVED tokens too
 * (the achromatic themes declare explicit hover/active/pill literals that
 * would otherwise keep the old hue), an invalid accent never reaches the root
 * style (an invalid var value silently drops every rule reading it), clearing
 * an override really clears it (inline vars outrank every theme block, so a
 * leftover would shadow all five themes), the pre-paint caches hold only
 * validated values, and "system" never reaches `data-theme` or the cache
 * unresolved — the CSS knows no such theme and would fall back to fancy_dark's
 * tokens while claiming otherwise.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

import {
  applyAccent,
  applyCorners,
  applyTheme,
  normalizeAccent,
  resolveTheme,
} from "../../stores/settings";
import { storageDashKey } from "../../lib/brand";

const rootStyle = () => document.documentElement.style;

beforeEach(() => {
  localStorage.clear();
  applyAccent(null);
  applyCorners(null);
});

describe("normalizeAccent", () => {
  it("accepts a full hex color, trimmed and lowercased", () => {
    expect(normalizeAccent(" #FF5C8A ")).toBe("#ff5c8a");
  });

  it("refuses everything that is not a full hex color", () => {
    for (const bad of ["", "red", "#abc", "#12345g", "36c5f0", null, undefined]) {
      expect(normalizeAccent(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe("applyAccent", () => {
  it("sets --accent AND the derived tokens inline, and caches for pre-paint", () => {
    applyAccent("#FF5C8A");
    expect(rootStyle().getPropertyValue("--accent")).toBe("#ff5c8a");
    // The derived pair is what makes the override behave like a theme accent on
    // the achromatic themes, whose explicit literals it must outrank.
    expect(rootStyle().getPropertyValue("--accent-hover")).toContain("color-mix");
    expect(rootStyle().getPropertyValue("--pill-active-border")).toBe("var(--accent)");
    expect(localStorage.getItem(storageDashKey("accent"))).toBe("#ff5c8a");
  });

  it("clearing removes every inline token and the cache", () => {
    applyAccent("#ff5c8a");
    applyAccent(null);
    expect(rootStyle().getPropertyValue("--accent")).toBe("");
    expect(rootStyle().getPropertyValue("--accent-hover")).toBe("");
    expect(rootStyle().getPropertyValue("--pill-active-bg")).toBe("");
    expect(localStorage.getItem(storageDashKey("accent"))).toBeNull();
  });

  it("an invalid accent is a clear, never a write", () => {
    applyAccent("#ff5c8a");
    applyAccent("purple");
    expect(rootStyle().getPropertyValue("--accent")).toBe("");
    expect(localStorage.getItem(storageDashKey("accent"))).toBeNull();
  });
});

describe("applyCorners", () => {
  it("rounded sets the three radius tokens and caches", () => {
    applyCorners("rounded");
    expect(rootStyle().getPropertyValue("--radius-sm")).toBe("4px");
    expect(rootStyle().getPropertyValue("--radius")).toBe("8px");
    expect(rootStyle().getPropertyValue("--radius-lg")).toBe("12px");
    expect(localStorage.getItem(storageDashKey("corners"))).toBe("rounded");
  });

  it("square sets zeros (a real override — soft_dark is rounded by default)", () => {
    applyCorners("square");
    expect(rootStyle().getPropertyValue("--radius")).toBe("0px");
    expect(localStorage.getItem(storageDashKey("corners"))).toBe("square");
  });

  it("clearing (or an unknown style) falls back to the theme's own tokens", () => {
    applyCorners("rounded");
    applyCorners("pill");
    expect(rootStyle().getPropertyValue("--radius-sm")).toBe("");
    expect(rootStyle().getPropertyValue("--radius")).toBe("");
    expect(localStorage.getItem(storageDashKey("corners"))).toBeNull();
  });
});

describe("system theme", () => {
  it("a concrete theme passes through untouched", () => {
    expect(resolveTheme("light_lavender")).toBe("light_lavender");
  });

  it("resolves to Plain Dark when the OS preference is unreadable", () => {
    // jsdom has no matchMedia — "system" is a light/dark pick, so it falls back dark.
    expect(resolveTheme("system")).toBe("dark");
  });

  it("follows the OS light preference when readable", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("light"),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      expect(resolveTheme("system")).toBe("fancy_light");
    } finally {
      window.matchMedia = original;
    }
  });

  it("applyTheme never lets 'system' reach data-theme or the pre-paint cache", () => {
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(storageDashKey("theme"))).toBe("dark");
  });

  it("marks a 'system' pick on the root, for the looks only it has", () => {
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme-pick")).toBe("system");
    applyTheme("light_lavender");
    expect(document.documentElement.hasAttribute("data-theme-pick")).toBe(false);
  });
});
