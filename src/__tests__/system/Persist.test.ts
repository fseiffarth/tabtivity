import { beforeEach, describe, expect, it } from "vitest";
import { cappedMap, readJson, writeJson, type JsonStorage } from "../../lib/persist";

function fake(initial: Record<string, string> = {}): JsonStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

const refusing: JsonStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};

describe("persist / readJson", () => {
  beforeEach(() => localStorage.clear());

  it("hands the parsed value to the checker and returns what it keeps", () => {
    const store = fake({ k: JSON.stringify({ a: 1, b: "x" }) });
    expect(readJson("k", (raw) => (raw as { a: number }).a, -1, store)).toBe(1);
  });

  it("gives the fallback for a missing key, bad JSON, a throwing checker and a refusing store", () => {
    expect(readJson("k", () => "parsed", "fallback", fake())).toBe("fallback");
    expect(readJson("k", () => "parsed", "fallback", fake({ k: "not json" }))).toBe("fallback");
    expect(readJson("k", () => { throw new Error("odd shape"); }, "fallback", fake({ k: "1" }))).toBe("fallback");
    expect(readJson("k", () => "parsed", "fallback", refusing)).toBe("fallback");
  });

  it("defaults to localStorage", () => {
    localStorage.setItem("k", "[1,2]");
    expect(readJson("k", (raw) => raw, null)).toEqual([1, 2]);
  });
});

describe("persist / writeJson", () => {
  it("stores JSON, removes on undefined, and says whether the store took it", () => {
    const store = fake();
    expect(writeJson("k", { a: 1 }, store)).toBe(true);
    expect(store.data.k).toBe('{"a":1}');
    expect(writeJson("k", undefined, store)).toBe(true);
    expect("k" in store.data).toBe(false);
    expect(writeJson("k", 1, refusing)).toBe(false);
  });

  it("accepts a store with no removeItem", () => {
    const store: JsonStorage = { getItem: () => null, setItem: () => {} };
    expect(writeJson("k", undefined, store)).toBe(true);
  });
});

describe("persist / cappedMap", () => {
  it("keeps the last entries in insertion order", () => {
    expect(cappedMap({ a: 1, b: 2, c: 3 }, 2)).toEqual({ b: 2, c: 3 });
    expect(Object.keys(cappedMap({ a: 1, b: 2, c: 3 }, 2))).toEqual(["b", "c"]);
    const small = { a: 1 };
    expect(cappedMap(small, 5)).toBe(small);
  });
});
