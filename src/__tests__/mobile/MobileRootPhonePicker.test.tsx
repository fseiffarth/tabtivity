import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { MobileAccessPicker } from "../../components/mobile/MobileAccessPicker";

const invokeMock = vi.mocked(invoke);
const PIXEL = "pixelpixelpixelpixelpixel01";
const IPAD = "ipadipadipadipadipadipad_02";

/** Root's picker, unlike a project's, is opt-in: there is no "All phones", an
 * empty list is the default, and the last ticked phone may be unticked. */
describe("the picker for root's phones", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "mobile_paired_devices"
        ? [
            { id: PIXEL, name: "Pixel", created_at: 1_790_000_000 },
            { id: IPAD, name: "iPad", created_at: 1_790_000_000 },
          ]
        : null));
  });
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
  });

  const open = (devices: string[], onApply = vi.fn(() => Promise.resolve())) => {
    render(<MobileAccessPicker x={0} y={0} kind="root" enabled devices={devices} onApply={onApply} onClose={() => {}} />);
    return onApply;
  };

  it("lists the phones straight away, with no All phones and no Turn off", async () => {
    open([]);
    expect(await screen.findByRole("menuitemcheckbox", { name: "Pixel" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByText("Turn off")).toBeNull();
    expect(screen.getByText(/Root is off for every phone/)).toBeTruthy();
  });

  it("ticks a phone, and unticks the last one — an empty list is no phone", async () => {
    const user = userEvent.setup();
    const onApply = open([PIXEL]);
    const pixel = await screen.findByRole("menuitemcheckbox", { name: "Pixel" });
    expect((pixel as HTMLButtonElement).disabled).toBe(false);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "iPad" }));
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith(true, [PIXEL, IPAD]));
    await user.click(pixel);
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith(true, []));
  });
});
