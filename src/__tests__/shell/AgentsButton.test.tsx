/**
 * The header's Agents button (`header/AgentsButton`): a click opens the console
 * window on the Agents view, a click while that view is shown closes the
 * window, and it is pinned by default beside the other five view buttons
 * (`lib/headerPins`).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentsButton } from "../../components/header/AgentsButton";
import { APP_ICONS } from "../../components/header/appIcons";
import { HEADER_GROUPS, HEADER_ITEM_IDS, headerPinDefaults, isHeaderPinned } from "../../lib/headerPins";
import { useRootOverlayStore } from "../../stores/rootOverlay";

beforeEach(() => useRootOverlayStore.setState({ open: false, view: "root" }));
afterEach(cleanup);

describe("the Agents button", () => {
  it("opens the Agents view, and a second click while it is shown closes the window", () => {
    render(<AgentsButton />);
    const button = screen.getByRole("button", { name: /^Agents/ });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "agents" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("opens the view from another one, rather than closing the window", () => {
    render(<AgentsButton />);
    act(() => useRootOverlayStore.getState().openView("models"));
    fireEvent.click(screen.getByRole("button", { name: /^Agents/ }));
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "agents" });
  });
});

describe("the six view buttons in the top bar", () => {
  it("are all header items, in the apps run (machines in the status cluster), pinned by default", () => {
    const six = ["mail", "calendar", "todo", "agents", "models", "machines"] as const;
    for (const id of six) {
      expect(HEADER_ITEM_IDS).toContain(id);
      expect(isHeaderPinned(undefined, id, headerPinDefaults(null))).toBe(true);
    }
    expect(HEADER_GROUPS.apps).toContain("agents");
    expect(HEADER_GROUPS.status).toContain("machines");
    expect(APP_ICONS.agents).toBeTruthy();
  });
});
