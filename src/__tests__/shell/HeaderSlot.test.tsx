/**
 * `HeaderSlot` + `header_pins`: right-click an icon to pin it into the bar or
 * fold it behind the chevron, and the chevron exists only for what folds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HeaderSlot } from "../../components/header/HeaderSlot";
import { headerPinDefaults, isHeaderPinned, toggleHeaderPin } from "../../lib/headerPins";
import { MOBILE_HOST_KEY } from "../../lib/brand";
import type { Settings } from "../../types";
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

  it("keeps the phone icon in the bar until Mobile is on or its guide was opened", () => {
    const off = headerPinDefaults({} as Settings);
    expect(isHeaderPinned(undefined, "mobile", off)).toBe(true);
    expect(isHeaderPinned(undefined, "vpn", off)).toBe(false);
    const on = { [MOBILE_HOST_KEY]: { enabled: true } } as unknown as Settings;
    expect(isHeaderPinned(undefined, "mobile", headerPinDefaults(on))).toBe(false);
    const seen = { mobile_setup_seen: true } as Settings;
    expect(isHeaderPinned(undefined, "mobile", headerPinDefaults(seen))).toBe(false);
    // Not loaded yet: no nudge, so an enabled Mobile never flashes into the bar.
    expect(isHeaderPinned(undefined, "mobile", headerPinDefaults(null))).toBe(false);
  });

  it("saves a hide of the nudged phone icon as an override", () => {
    const off = headerPinDefaults({} as Settings);
    expect(toggleHeaderPin(undefined, "mobile", off)).toEqual({ mobile: false });
    expect(isHeaderPinned({ mobile: false }, "mobile", off)).toBe(false);
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

  it("keeps the phone icon unfolded while Mobile was never set up", () => {
    render(<HeaderSlot id="mobile"><i data-testid="mobile" /></HeaderSlot>);
    expect(screen.getByTestId("mobile").parentElement!.getAttribute("data-folded")).toBe("false");
    act(() => useSettingsStore.setState({ settings: { mobile_setup_seen: true } as never } as never));
    expect(screen.getByTestId("mobile").parentElement!.getAttribute("data-folded")).toBe("true");
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
