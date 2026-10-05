import { describe, expect, it } from "vitest";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

describe("resolveProjectDirectory", () => {
  it("recovers legacy Windows local_file paths", () => {
    const project = {
      local_file: `C:\\Users\\alice\\${BRAND.slug}\\projects\\demo\\project.json`,
    } as ProjectEntry;
    expect(resolveProjectDirectory(project)).toBe(
      `C:\\Users\\alice\\${BRAND.slug}\\projects\\demo`,
    );
  });
});
