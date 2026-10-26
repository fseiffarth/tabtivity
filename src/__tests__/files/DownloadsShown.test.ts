import { describe, expect, it, vi } from "vitest";
import { readDownloadsShown, writeDownloadsShown } from "../../lib/projects/downloadsShown";
import type { JsonStorage } from "../../lib/persist";

// test-setup.ts hides the section for every other test; this one tests the real thing.
vi.unmock("../../lib/projects/downloadsShown");

function memoryStorage(): JsonStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("downloadsShown", () => {
  it("is shown by default for both host kinds", () => {
    const s = memoryStorage();
    expect(readDownloadsShown("sidePanel", s)).toBe(true);
    expect(readDownloadsShown("fileViewer", s)).toBe(true);
  });

  it("remembers each host kind's last state on its own", () => {
    const s = memoryStorage();
    writeDownloadsShown("sidePanel", false, s);
    expect(readDownloadsShown("sidePanel", s)).toBe(false);
    expect(readDownloadsShown("fileViewer", s)).toBe(true);
    writeDownloadsShown("fileViewer", false, s);
    writeDownloadsShown("sidePanel", true, s);
    expect(readDownloadsShown("sidePanel", s)).toBe(true);
    expect(readDownloadsShown("fileViewer", s)).toBe(false);
  });

  it("reads a garbled record as shown", () => {
    const s = memoryStorage();
    for (const raw of ["not json", "null", '{"sidePanel":"no"}', "[false]"]) {
      s.data.clear();
      // Write through the real key, then overwrite its value with junk.
      writeDownloadsShown("sidePanel", false, s);
      const key = [...s.data.keys()][0];
      s.data.set(key, raw);
      expect(readDownloadsShown("sidePanel", s)).toBe(true);
    }
  });
});
