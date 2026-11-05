/**
 * Fullscreen auto-hide: only in the window's own fullscreen mode does the top
 * bar step out of the layout; the pointer at the top edge slides it down and
 * leaving it (with nothing open in it) slides it back up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("../../components/layout/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("../../components/header/StatusCluster", () => ({ StatusCluster: () => null }));
vi.mock("../../components/header/Clock", () => ({ Clock: () => null }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../components/header/HeaderSlot", () => ({ HeaderSlot: () => null }));

import { HeaderBar } from "../../components/layout/HeaderBar";
import { useFullscreenMode } from "../../lib/window/fullscreenMode";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useSettingsStore } from "../../stores/settings";

beforeEach(() => {
  vi.useFakeTimers();
  useFullscreenMode.setState({ on: false });
  useHeaderHoverMenuStore.setState({ openId: null, held: false });
  useSettingsStore.setState({ settings: {} as never } as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HeaderBar fullscreen auto-hide", () => {
  it("is the ordinary bar when windowed", () => {
    const { container } = render(<HeaderBar />);
    expect(container.querySelector(".app-header.is-autohide")).toBeNull();
    expect(container.querySelector(".header-hotzone")).toBeNull();
  });

  it("hides in fullscreen, drops down at the top edge and goes back up", () => {
    useFullscreenMode.setState({ on: true });
    const { container } = render(<HeaderBar />);
    const bar = container.querySelector(".app-header") as HTMLElement;
    expect(bar.classList.contains("is-autohide")).toBe(true);
    expect(bar.classList.contains("is-revealed")).toBe(false);

    fireEvent.mouseEnter(container.querySelector(".header-hotzone") as HTMLElement);
    expect(bar.classList.contains("is-revealed")).toBe(true);
    expect(container.querySelector(".header-hotzone")).toBeNull();

    fireEvent.mouseEnter(bar);
    fireEvent.mouseLeave(bar);
    act(() => void vi.advanceTimersByTime(600));
    expect(bar.classList.contains("is-revealed")).toBe(false);
  });

  it("stays down while a header menu is open", () => {
    useFullscreenMode.setState({ on: true });
    const { container } = render(<HeaderBar />);
    const bar = container.querySelector(".app-header") as HTMLElement;
    fireEvent.mouseEnter(container.querySelector(".header-hotzone") as HTMLElement);
    useHeaderHoverMenuStore.setState({ openId: "mail" });
    fireEvent.mouseLeave(bar);
    act(() => void vi.advanceTimersByTime(1500));
    expect(bar.classList.contains("is-revealed")).toBe(true);
    useHeaderHoverMenuStore.setState({ openId: null });
    act(() => void vi.advanceTimersByTime(1000));
    expect(bar.classList.contains("is-revealed")).toBe(false);
  });

  it("returns to the plain bar when fullscreen ends", () => {
    useFullscreenMode.setState({ on: true });
    const { container } = render(<HeaderBar />);
    fireEvent.mouseEnter(container.querySelector(".header-hotzone") as HTMLElement);
    act(() => useFullscreenMode.setState({ on: false }));
    expect(container.querySelector(".app-header.is-autohide")).toBeNull();
  });
});
