import { describe, expect, it } from "vitest";
import { entryHash, formatBundleVersion } from "../../../mobile-web/src/buildInfo";
import { BRAND } from "../../lib/brand";

describe(`${BRAND.display} Mobile bundle version`, () => {
  it("reads the entry chunk's hash off the page's script URLs", () => {
    expect(entryHash([{ src: "https://phone.example/assets/vendor-AAAA1111.js" }, { src: "https://phone.example/assets/index-Bx9_k-Q2zZ.js" }])).toBe("Bx9_k-Q2");
    expect(entryHash([{ src: "/assets/index-abc123.js?v=1" }])).toBe("abc123");
  });

  it("is empty without a hashed entry (the dev server's /src/main.tsx)", () => {
    expect(entryHash([{ src: "http://localhost:5173/src/main.tsx" }])).toBe("");
    expect(entryHash([{ src: "/assets/index-abc.js.map" }])).toBe("");
    expect(entryHash([])).toBe("");
  });

  it("joins version and hash, skipping an empty hash", () => {
    expect(formatBundleVersion("0.1.99", "Bx9_k-Q2")).toBe("v0.1.99 · Bx9_k-Q2");
    expect(formatBundleVersion("0.1.99", "")).toBe("v0.1.99");
  });
});
