/**
 * Steering and the window losing the keyboard: a desktop screenshot (PrtSc, a
 * region, Enter) or a notification blurs the window for a few seconds, and
 * steering is still on when it comes back. Only a long absence ends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { STEERING_BLUR_GRACE_MS, useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const steering = () => useKeyboardSteeringStore.getState();
const fire = (type: "blur" | "focus") => act(() => void window.dispatchEvent(new Event(type)));

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ settings: null });
  steering().exit();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  steering().exit();
});

describe("steering through a window blur", () => {
  it("stays on when the window comes back soon (a screenshot taken with Enter)", () => {
    render(<Keyboard />);
    act(() => steering().enter());
    fire("blur");
    expect(steering().active).toBe(true);
    vi.advanceTimersByTime(5_000);
    fire("focus");
    expect(steering().active).toBe(true);
  });

  it("ends when the window was away longer than the grace", () => {
    render(<Keyboard />);
    act(() => steering().enter());
    fire("blur");
    vi.advanceTimersByTime(STEERING_BLUR_GRACE_MS + 1);
    fire("focus");
    expect(steering().active).toBe(false);
  });

  it("a blur while steering was off does not end a later steering", () => {
    render(<Keyboard />);
    fire("blur");
    vi.advanceTimersByTime(STEERING_BLUR_GRACE_MS + 1);
    act(() => steering().enter());
    fire("focus");
    expect(steering().active).toBe(true);
  });
});
