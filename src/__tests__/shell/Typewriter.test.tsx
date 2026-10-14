import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { Typewriter } from "../../components/common/Typewriter";

const TEXT = "Hi there — I'm here.";

/** What a sighted user sees: the aria-hidden typed copy. */
const typed = (container: HTMLElement) =>
  container.querySelector("[aria-hidden='true']")?.textContent ?? "";

describe("Typewriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("types the line out over time and marks itself done", () => {
    const { container } = render(<Typewriter text={TEXT} />);
    expect(typed(container)).toBe("");
    act(() => vi.advanceTimersByTime(45 * 3));
    const partial = typed(container);
    expect(partial.length).toBeGreaterThan(0);
    expect(TEXT.startsWith(partial)).toBe(true);
    expect(container.querySelector(".typewriter.done")).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(typed(container)).toBe(TEXT);
    expect(container.querySelector(".typewriter.done")).not.toBeNull();
  });

  it("gives screen readers the whole line from the start", () => {
    const { container } = render(<Typewriter text={TEXT} />);
    expect(container.querySelector(".typewriter-sr")?.textContent).toBe(TEXT);
  });

  it("a click or any key completes it at once", () => {
    const { container } = render(<Typewriter text={TEXT} />);
    fireEvent.click(container.querySelector(".typewriter")!);
    expect(typed(container)).toBe(TEXT);

    cleanup();
    const second = render(<Typewriter text={TEXT} />);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(typed(second.container)).toBe(TEXT);
  });

  it("shows the line complete when not animated", () => {
    const { container } = render(<Typewriter text={TEXT} animate={false} />);
    expect(typed(container)).toBe(TEXT);
    expect(container.querySelector(".typewriter.done")).not.toBeNull();
  });

  it("shows the line complete under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }) as MediaQueryList);
    const { container } = render(<Typewriter text={TEXT} />);
    expect(typed(container)).toBe(TEXT);
  });

  it("a text change after it finished shows the new text complete", () => {
    const { container, rerender } = render(<Typewriter text={TEXT} />);
    act(() => vi.advanceTimersByTime(5000));
    rerender(<Typewriter text="Hallo — hier bin ich." />);
    expect(typed(container)).toBe("Hallo — hier bin ich.");
  });
});
