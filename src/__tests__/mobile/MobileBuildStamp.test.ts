import { describe, expect, it } from "vitest";
import { formatBuildStamp, formatBundleVersion } from "../../../mobile-web/src/buildInfo";
import { BRAND } from "../../lib/brand";

describe(`${BRAND.display} Mobile build stamp`, () => {
  it("formats as dd-mm hh:mm in local time", () => {
    const local = new Date(2026, 8, 6, 7, 5).toISOString();
    expect(formatBuildStamp(local)).toBe("06-09 07:05");
  });

  it("is empty when the stamp is missing or unreadable", () => {
    expect(formatBuildStamp(undefined)).toBe("");
    expect(formatBuildStamp("not a date")).toBe("");
  });

  it("joins version, commit and stamp, skipping the empty ones", () => {
    expect(formatBundleVersion("0.1.99", "f1b3161", "30-09 14:05")).toBe("v0.1.99 · f1b3161 · 30-09 14:05");
    expect(formatBundleVersion("0.1.99", "", "30-09 14:05")).toBe("v0.1.99 · 30-09 14:05");
    expect(formatBundleVersion("0.1.99", "", "")).toBe("v0.1.99");
  });
});
