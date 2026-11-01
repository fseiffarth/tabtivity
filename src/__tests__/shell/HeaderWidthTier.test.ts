/** The top bar's width tiers: badges, then the clock, then the cluster. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { headerWidthTier } from "../../lib/headerPins";

describe("headerWidthTier", () => {
  it("folds nothing on a wide bar", () => {
    expect(headerWidthTier(1920)).toBe(0);
    expect(headerWidthTier(1280)).toBe(0);
  });

  it("gives way one step at a time as the bar narrows", () => {
    expect(headerWidthTier(1279)).toBe(1);
    expect(headerWidthTier(1100)).toBe(1);
    expect(headerWidthTier(1099)).toBe(2);
    expect(headerWidthTier(900)).toBe(2);
    expect(headerWidthTier(899)).toBe(3);
    expect(headerWidthTier(0)).toBe(3);
  });
});
