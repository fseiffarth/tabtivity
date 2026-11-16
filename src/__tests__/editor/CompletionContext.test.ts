import { describe, expect, it, vi } from "vitest";
import {
  AUTO_REFERENCE_BYTES, ReferenceReads, completionContext, completionImports, referenceBudget, referenceSetId, trimReferences,
} from "../../lib/viewers/completion/completionContext";
import { CompletionCache, completionLineLength, modelLookupCache } from "../../lib/viewers/completion/autocomplete";

describe("completion references", () => {
  it("resolves local imports and TeX inputs without escaping the project", () => {
    expect(completionImports("import x from './helper'; import y from '../../private.ts';", "/p/src/a.ts", "/p"))
      .toEqual(["/p/src/helper.ts", "/p/src/helper.tsx", "/p/src/helper.js", "/p/src/helper/index.ts"]);
    expect(completionImports("from .helper import x\nimport package.module", "/p/src/a.py", "/p"))
      .toContain("/p/src/helper.py");
    expect(completionImports("\\input{chapter} \\bibliography{one,two} \\input{../../secret}", "/p/a.tex", "/p"))
      .toEqual(["/p/chapter.tex", "/p/one.bib", "/p/two.bib"]);
  });

  it("prioritizes manual references, caps UTF-8 bytes and never reads outside the project", async () => {
    const read = vi.fn().mockResolvedValue("😀".repeat(3000));
    const result = await completionContext({
      path: "/p/a.ts", root: "/p", draft: "", signal: new AbortController().signal,
      manual: [{ name: "manual", content: "ü".repeat(4000) }],
      openPaths: ["/elsewhere/private", "/p/e.ts", "/p/a.ts", "/p/b.ts", "/p/b.ts", "/p/d.ts", "/p/c.ts"], read,
      explicit: true,
    });
    expect(result[0].name).toBe("manual");
    expect(result.map((f) => new TextEncoder().encode(f.content).length)).toEqual([6000, 6000, 6000, 6000]);
    expect(result.every((f) => !f.content.includes("�"))).toBe(true);
    expect(read.mock.calls.flat()).toEqual(["/p/b.ts", "/p/c.ts", "/p/d.ts"]);
  });

  it("adds current labels and bib keys, tolerates unreadable inputs, and stops after cancellation", async () => {
    const controller = new AbortController();
    const read = vi.fn(async (path: string) => {
      if (path.endsWith("missing.tex")) throw new Error("missing");
      return "@article{key2026, title={Long title}}";
    });
    const opts = {
      path: "/p/a.tex", root: "/p", draft: "\\input{missing} \\bibliography{refs}",
      signal: controller.signal, manual: [], openPaths: [], keys: "sec:intro", read,
    };
    expect(await completionContext(opts)).toEqual([
      { name: "LaTeX label / bibliography keys", content: "sec:intro" },
      { name: "refs.bib", content: "key2026" },
    ]);
    controller.abort();
    read.mockClear();
    await completionContext(opts);
    expect(read).not.toHaveBeenCalled();
  });

  const base = (read: (path: string) => Promise<string>) => ({
    path: "/p/src/a.ts", root: "/p", signal: new AbortController().signal, manual: [],
    draft: "import x from './x';\nimport y from './y.ts';", openPaths: ["/p/tab2.ts", "/p/tab1.ts"], read,
  });

  it("automatic requests take imports only, 4 KB in all, in source order", async () => {
    const read = vi.fn(async (path: string) => {
      if (["/p/src/x.ts", "/p/src/y.ts", "/p/tab1.ts", "/p/tab2.ts"].includes(path)) return "z".repeat(3000);
      throw new Error("missing");
    });
    const result = await completionContext(base(read));
    expect(result.map((r) => r.name)).toEqual(["src/x.ts", "src/y.ts"]);
    expect(result.reduce((n, r) => n + r.content.length, 0)).toBe(AUTO_REFERENCE_BYTES);
    expect(read.mock.calls.flat().some((p) => p.includes("tab"))).toBe(false);
    // Explicit: open tabs too, sorted by path, after the imports.
    const explicit = await completionContext({ ...base(read), explicit: true });
    expect(explicit.map((r) => r.name)).toEqual(["src/x.ts", "src/y.ts", "tab1.ts", "tab2.ts"]);
  });

  it("freezes reads per editor until the import list changes or the user asks", async () => {
    const read = vi.fn(async (path: string) => {
      if (path === "/p/src/x.ts") return "export const x = 1;";
      throw new Error("missing");
    });
    const reads = new ReferenceReads();
    const first = await completionContext({ ...base(read), reads });
    const tried = read.mock.calls.length;
    expect(tried).toBeGreaterThan(0);
    // A second automatic gathering reads nothing, missing candidates included.
    expect(await completionContext({ ...base(read), reads })).toEqual(first);
    expect(read).toHaveBeenCalledTimes(tried);
    // An explicit request reads afresh.
    await completionContext({ ...base(read), reads, explicit: true });
    expect(read.mock.calls.length).toBeGreaterThan(tried);
    // A changed import list reads afresh too.
    read.mockClear();
    await completionContext({ ...base(read), reads, draft: "import z from './z';" });
    expect(read).toHaveBeenCalled();
  });

  it("counts files that exist against the cap, not candidate paths", async () => {
    const draft = Array.from({ length: 20 }, (_, i) => `import m${i} from './m${i}';`).join("\n");
    // Only the `/index.ts` candidate of each import exists: four paths per file.
    const read = vi.fn(async (path: string) => {
      if (path.endsWith("/index.ts")) return "x";
      throw new Error("missing");
    });
    const result = await completionContext({ ...base(read), draft, explicit: true });
    expect(result).toHaveLength(16);
  });

  it("budgets explicit requests by the model's context, else like automatic ones", () => {
    expect(referenceBudget(false, 262144)).toBe(AUTO_REFERENCE_BYTES);
    expect(referenceBudget(true, 262144)).toBe(24000);
    expect(referenceBudget(true, 8192)).toBe(6144);
    expect(referenceBudget(true, null)).toBe(AUTO_REFERENCE_BYTES);
    expect(referenceBudget(true, undefined)).toBe(AUTO_REFERENCE_BYTES);
  });

  it("trims in order and ids a set by names and contents", () => {
    const set = [{ name: "a", content: "ü".repeat(10) }, { name: "b", content: "bbbb" }];
    expect(trimReferences(set, 20)).toEqual([{ name: "a", content: "ü".repeat(10) }]);
    expect(trimReferences(set, 22)).toEqual([...set.slice(0, 1), { name: "b", content: "bb" }]);
    expect(referenceSetId(set)).toBe(referenceSetId(set.map((r) => ({ ...r }))));
    expect(referenceSetId(set)).not.toBe(referenceSetId([set[1], set[0]]));
    expect(referenceSetId([{ name: "a", content: "x" }])).not.toBe(referenceSetId([{ name: "a", content: "y" }]));
    expect(referenceSetId([])).toBe("");
  });
});

describe("completion caches", () => {
  it("deduplicates model queries, expires loaded state and retries failures", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const lookup = vi.fn().mockResolvedValue([{ name: "coder", running: true }]);
      const cached = modelLookupCache();
      await Promise.all([cached("local", lookup), cached("local", lookup)]);
      expect(lookup).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6001);
      await cached("local", lookup);
      expect(lookup).toHaveBeenCalledTimes(2);
      lookup.mockRejectedValueOnce(new Error("offline"));
      await expect(cached("other", lookup)).rejects.toThrow("offline");
      await cached("other", lookup);
      expect(lookup).toHaveBeenCalledTimes(4);
    } finally { now.mockRestore(); }
  });

  it("bounds completion memory and expires old suggestions", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const cache = new CompletionCache();
      for (let i = 0; i < 24; i++) cache.set(String(i), "result");
      expect(cache.get("0")).toBe("result");
      cache.set("24", "next");
      expect(cache.get("1")).toBeUndefined();
      expect(cache.get("0")).toBe("result");
      now.mockReturnValue(60_001);
      expect(cache.get("0")).toBeUndefined();
    } finally { now.mockRestore(); }
  });

  it("accepts whole lines including leading/trailing line breaks", () => {
    for (const [text, chunk] of [["first\nsecond", "first\n"], ["\n  first\nsecond", "\n  first\n"], ["\r\n  first\r\nsecond", "\r\n  first\r\n"], ["last", "last"]]) {
      expect(text.slice(0, completionLineLength(text))).toBe(chunk);
    }
  });
});
