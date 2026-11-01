/**
 * A dismissed menu fades before it unmounts, and only when the token says so:
 * `--motion-exit` is 0 under reduced motion, where it closes at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ContextMenuPortal } from "../../components/common/ContextMenuPortal";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--motion-exit");
  vi.useRealTimers();
});

const open = (onClose: () => void) =>
  render(
    <ContextMenuPortal x={10} y={10} onClose={onClose}>
      <button type="button">row</button>
    </ContextMenuPortal>,
  );

describe("ContextMenuPortal leaving", () => {
  it("closes at once with no exit duration", () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("holds the menu for the exit duration, faded, with the catcher gone", () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty("--motion-exit", "80ms");
    const onClose = vi.fn();
    open(onClose);
    fireEvent.pointerDown(document.querySelector(".context-menu-catcher")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".context-menu-portal.is-leaving")).toBeTruthy();
    expect(document.querySelector(".context-menu-catcher")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
