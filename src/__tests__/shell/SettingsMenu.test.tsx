/**
 * The header's ⚙ (moved out of the project switcher, `header/SettingsMenu`).
 *
 * Its wiring changed from "set this component's own state" to "dispatch a
 * window event", which is precisely the kind of move that fails silently: a
 * mistyped event name leaves a menu row that opens nothing and throws nothing.
 * So every row is asserted against the listener that answers it — including
 * `tabtivity:open-settings`, whose `detail` is the panel `ProjectSwitcher` opens
 * the dialog on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

import { SettingsMenu } from "../../components/header/SettingsMenu";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";

function renderMenu() {
  const { container } = render(<SettingsMenu />);
  const btn = container.querySelector('[data-hint-anchor="settings"]') as HTMLElement;
  act(() => {
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
  });
  return { container, btn };
}

function rowNamed(container: HTMLElement, text: string): HTMLElement {
  return [...container.querySelectorAll(".project-switcher-add-menu button")].find(
    (b) => b.textContent === text,
  ) as HTMLElement;
}

beforeEach(() => {
  useHeaderHoverMenuStore.setState({ openId: null });
});
afterEach(() => {
  useHeaderHoverMenuStore.setState({ openId: null });
});

describe("header settings menu", () => {
  it("reveals on hover and claims the SHARED header hover-menu id", async () => {
    // The shared id is the whole reason the gear moved onto it: with its own
    // timer it could render alongside a cluster menu the pointer had left.
    const { container } = renderMenu();
    expect(container.querySelector(".project-switcher-add-menu")).toBeTruthy();
    expect(useHeaderHoverMenuStore.getState().openId).toBe("settings");

    act(() => {
      useHeaderHoverMenuStore.getState().open("global-apps");
    });
    expect(container.querySelector(".project-switcher-add-menu")).toBeNull();
  });

  it("opens the settings dialog on the main panel", () => {
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("app:open-settings", onOpen);
    const { container } = renderMenu();
    act(() => {
      fireEvent.click(rowNamed(container, "Settings"));
    });
    window.removeEventListener("app:open-settings", onOpen);
    expect(seen).toEqual(["main"]);
    // …and the menu closes behind it.
    expect(container.querySelector(".project-switcher-add-menu")).toBeNull();
  });

  it("clicking the gear itself opens the settings dialog on the main panel", () => {
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("app:open-settings", onOpen);
    const { container, btn } = renderMenu();
    act(() => {
      fireEvent.click(btn);
    });
    window.removeEventListener("app:open-settings", onOpen);
    expect(seen).toEqual(["main"]);
    expect(container.querySelector(".project-switcher-add-menu")).toBeNull();
  });

  it("opens the settings dialog on the help panel", () => {
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("app:open-settings", onOpen);
    const { container } = renderMenu();
    act(() => {
      fireEvent.click(rowNamed(container, "Feature Guide"));
    });
    window.removeEventListener("app:open-settings", onOpen);
    expect(seen).toEqual(["help"]);
  });

  it("opens the settings dialog on the updates panel, as the last row", () => {
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("app:open-settings", onOpen);
    const { container } = renderMenu();
    const rows = container.querySelectorAll(".project-switcher-add-menu button");
    const row = rows[rows.length - 1] as HTMLElement;
    expect(row.textContent).toBe("Check for updates");
    act(() => {
      fireEvent.click(row);
    });
    window.removeEventListener("app:open-settings", onOpen);
    expect(seen).toEqual(["updates"]);
  });

  it("fires the how-to-start and lessons events", () => {
    const rows: [string, string][] = [
      ["How to start", "app:open-how-to-start"],
      ["Lessons", "app:open-lessons"],
    ];
    for (const [label, event] of rows) {
      const fired = vi.fn();
      window.addEventListener(event, fired);
      const { container } = renderMenu();
      const row = rowNamed(container, label);
      expect(row, `no row labelled "${label}"`).toBeTruthy();
      act(() => {
        fireEvent.click(row);
      });
      window.removeEventListener(event, fired);
      expect(fired, `${label} → ${event}`).toHaveBeenCalledTimes(1);
      useHeaderHoverMenuStore.setState({ openId: null });
    }
  });
});
