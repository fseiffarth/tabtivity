import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { penKnown, usePenWriting } from "../../../mobile-web/src/penWriting";
import { BRAND, storageDashKey } from "../../lib/brand";

function pointer(type: string, pointerType: string) {
  document.body.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType }));
}

describe(`${BRAND.display} Mobile pen writing`, () => {
  beforeEach(() => localStorage.clear());

  it("knows no pen on an untouched device", () => {
    expect(penKnown()).toBe(false);
    expect(renderHook(() => usePenWriting()).result.current).toBe(false);
  });

  it("takes Mark up's pen as known", () => {
    localStorage.setItem(storageDashKey("markup-pen"), "fingers");
    expect(penKnown()).toBe(true);
  });

  it("ignores fingers and a mouse, and turns on — remembered — at a pen", () => {
    const { result } = renderHook(() => usePenWriting());
    act(() => { pointer("pointerdown", "touch"); pointer("pointerover", "mouse"); });
    expect(result.current).toBe(false);
    act(() => pointer("pointerover", "pen"));
    expect(result.current).toBe(true);
    expect(penKnown()).toBe(true);
    expect(renderHook(() => usePenWriting()).result.current).toBe(true);
  });
});
