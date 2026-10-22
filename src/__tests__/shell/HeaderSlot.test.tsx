/**
 * `HeaderSlot` + `header_pins`: right-click an icon to pin it into the bar or
 * fold it behind the chevron, and the chevron exists only for what folds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HeaderSlot } from "../../components/header/HeaderSlot";
import { isHeaderPinned, toggleHeaderPin } from "../../lib/headerPins";
import { useHeaderSlotsStore } from "../../stores/headerSlots";
import { useSettingsStore } from "../../stores/settings";

const updateSettings = vi.fn(() => Promise.resolve());

beforeEach(() => {
  localStorage.clear();
  useHeaderSlotsStore.setState({ present: {} });
  useSettingsStore.setState({ settings: {} as never, updateSettings } as never);
});

afterEach(() => {
  cleanup();
  updateSettings.mockClear();
});

describe("headerPins", () => {
  it("pins the global apps and folds the readouts by default", () => {
    expect(isHeaderPinned(undefined, "mail")).toBe(true);
    expect(isHeaderPinned(undefined, "vpn")).toBe(false);
    expect(isHeaderPinned({ mail: false, vpn: true }, "mail")).toBe(false);
    expect(isHeaderPinned({ mail: false, vpn: true }, "vpn")).toBe(true);
  });

  it("drops an override that flips back to the default", () => {
    const folded = toggleHeaderPin(undefined, "mail");
    expect(folded).toEqual({ mail: false });
    expect(toggleHeaderPin(folded, "mail")).toEqual({});
  });
});

describe("HeaderSlot", () => {
  it("keeps a pinned item in the bar and folds an unpinned one", () => {
    render(
      <>
        <HeaderSlot id="mail"><i data-testid="mail" /></HeaderSlot>
        <HeaderSlot id="vpn"><i data-testid="vpn" /></HeaderSlot>
      </>,
    );
    expect(screen.getByTestId("mail").parentElement!.getAttribute("data-folded")).toBe("false");
    expect(screen.getByTestId("vpn").parentElement!.getAttribute("data-folded")).toBe("true");
  });

  it("shows everything while the chevron is expanded", () => {
    useSettingsStore.setState({ settings: { header_status_expanded: true } as never } as never);
    render(<HeaderSlot id="vpn"><i data-testid="vpn" /></HeaderSlot>);
    expect(screen.getByTestId("vpn").parentElement!.getAttribute("data-folded")).toBe("false");
  });

  it("right-click offers to fold a pinned item and saves the override", () => {
    render(<HeaderSlot id="mail"><i data-testid="mail" /></HeaderSlot>);
    fireEvent.contextMenu(screen.getByTestId("mail"));
    fireEvent.click(screen.getByText("Hide behind the ‹ chevron"));
    expect(updateSettings).toHaveBeenCalledWith({ header_pins: { mail: false } });
  });

  it("right-click offers to pin a folded item", () => {
    render(<HeaderSlot id="vpn"><i data-testid="vpn" /></HeaderSlot>);
    fireEvent.contextMenu(screen.getByTestId("vpn"));
    fireEvent.click(screen.getByText("Always show in the top bar"));
    expect(updateSettings).toHaveBeenCalledWith({ header_pins: { vpn: true } });
  });

  it("leaves a right-click inside the item's own popover alone", () => {
    render(
      <HeaderSlot id="mail">
        <div className="tab-new-menu"><i data-testid="inner" /></div>
      </HeaderSlot>,
    );
    fireEvent.contextMenu(screen.getByTestId("inner"));
    expect(screen.queryByText("Hide behind the ‹ chevron")).toBeNull();
  });

  it("reports whether it holds anything", async () => {
    const { rerender } = render(<HeaderSlot id="inbox">{null}</HeaderSlot>);
    expect(useHeaderSlotsStore.getState().present.inbox).toBeUndefined();
    rerender(<HeaderSlot id="inbox"><i /></HeaderSlot>);
    await waitFor(() => expect(useHeaderSlotsStore.getState().present.inbox).toBe(true));
  });
});
