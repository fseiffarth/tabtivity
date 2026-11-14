import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableList } from "../../hooks/useStableList";

describe("useStableList", () => {
  it("keeps the array it first saw while the items stay the same", () => {
    const first = ["a", "b"];
    const { result, rerender } = renderHook(({ list }) => useStableList(list), { initialProps: { list: first } });
    expect(result.current).toBe(first);
    rerender({ list: ["a", "b"] });
    expect(result.current).toBe(first);
  });

  it("takes a new array when an item, the order or the length changes", () => {
    const { result, rerender } = renderHook(({ list }) => useStableList(list), { initialProps: { list: ["a", "b"] } });
    for (const next of [["a", "c"], ["c", "a"], ["c", "a", "d"], []]) {
      rerender({ list: next });
      expect(result.current).toBe(next);
    }
  });
});
